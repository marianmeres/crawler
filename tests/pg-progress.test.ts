/**
 * The live progress writer: `progress()` throttling, its trailing flush, and the two
 * ways a snapshot must never win — over a terminal `markEnded`, or over the crawl itself
 * when the write fails.
 *
 * Every `stats` UPDATE is counted by a proxy sitting between `CrawlerPg` and the pool,
 * because "one intermediate and one trailing write" is a claim about statements issued,
 * not about the row's final content — a row that ends up right after four writes is
 * still a row written four times.
 *
 * Gated on `TEST_PG_DATABASE` only: with the variable set but the server unreachable
 * these tests fail rather than skip.
 *
 * @module
 */

import { assert, assertEquals } from "@std/assert";
import type pg from "pg";
import { createPg } from "./_pg.ts";
import { recordingLogger } from "./_helpers.ts";
import { type CrawlPersistence, createCrawlerPg } from "../src/pg/mod.ts";
import type { CrawlStats } from "../src/mod.ts";

const hasPg = !!Deno.env.get("TEST_PG_DATABASE");

const TEST_PREFIX = "_test_progress_";
const TABLE_CRAWL = `${TEST_PREFIX}__crawler_crawl`;

/** Long enough that a local round-trip cannot drift out of the window mid-assertion. */
const THROTTLE = 300;

/** The statement under test, as the proxy recognizes it. */
const STATS_WRITE = "SET stats = $2::jsonb";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function stats(done: number): CrawlStats {
	return {
		crawlId: "test-crawl",
		queued: 0,
		inFlight: 0,
		done,
		failed: 0,
		skipped: 0,
		bytes: 100 * done,
		startedAt: Date.now(),
		elapsed: 42,
		pagesPerSecond: 1,
		byStatus: { 200: done },
		skippedByReason: {},
	};
}

/**
 * The pool, with every progress write recorded and optionally rejected. Only `query` is
 * needed: neither the lazy install nor `progress()` reaches for a pooled client.
 */
function proxyPool(
	db: pg.Pool,
	seen: number[],
	fail: boolean,
): pg.Pool {
	return {
		query: (text: string, values?: unknown[]) => {
			if (text.includes(STATS_WRITE)) {
				seen.push(JSON.parse(String(values?.[1])).done);
				if (fail) return Promise.reject(new Error("forced progress failure"));
			}
			return db.query(text, values);
		},
	} as unknown as pg.Pool;
}

function pgTest(
	name: string,
	fn: (ctx: {
		run: CrawlPersistence;
		newRun: () => Promise<CrawlPersistence>;
		db: pg.Pool;
		/** The `done` counter of every progress write issued, in order. */
		seen: number[];
		logger: ReturnType<typeof recordingLogger>;
	}) => Promise<void>,
	options: { failWrites?: boolean } = {},
): void {
	Deno.test({ name: `pg: ${name}`, ignore: !hasPg }, async () => {
		const db = createPg();
		const seen: number[] = [];
		const logger = recordingLogger();
		const crawlerPg = createCrawlerPg({
			db: proxyPool(db, seen, options.failWrites ?? false),
			tablePrefix: TEST_PREFIX,
			progressThrottleMs: THROTTLE,
			logger,
		});
		const newRun = () => crawlerPg.createCrawl({ seeds: ["https://a.test/"] });
		try {
			await crawlerPg.resetHard();
			await fn({ run: await newRun(), newRun, db, seen, logger });
		} finally {
			await crawlerPg.uninstall().catch(() => {});
			await db.end();
		}
	});
}

async function storedStats(db: pg.Pool, uid: string): Promise<Partial<CrawlStats>> {
	const { rows } = await db.query(
		`SELECT stats FROM ${TABLE_CRAWL} WHERE uid = $1`,
		[uid],
	);
	return rows[0]?.stats ?? {};
}

async function waitFor(
	condition: () => Promise<boolean>,
	message: string,
	timeoutMs = 5000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await condition()) return;
		await delay(20);
	}
	throw new Error(`Timed out waiting for ${message}`);
}

pgTest("rapid progress calls collapse into one write plus a trailing flush", async (
	{ run, db, seen },
) => {
	await run.progress(stats(1));
	// the same window, so none of these three reaches the server on its own
	await run.progress(stats(2));
	await run.progress(stats(3));
	await run.progress(stats(4));

	assertEquals(seen, [1], "the throttle let a windowed call through");
	assertEquals((await storedStats(db, run.crawl.uid)).done, 1);

	await waitFor(
		async () => (await storedStats(db, run.crawl.uid)).done === 4,
		"the trailing flush of the last snapshot",
	);
	assertEquals(seen, [1, 4], "the trailing flush wrote more than the last snapshot");

	// and it is trailing, not repeating: an idle window adds nothing
	await delay(THROTTLE * 2);
	assertEquals(seen, [1, 4]);
	assertEquals(run.crawl.stats.done, 4, "the handle's row is stale after a flush");
});

pgTest("markEnded force-writes the terminal snapshot from inside a window", async (
	{ run, db, seen },
) => {
	await run.progress(stats(1));
	await run.progress(stats(2)); // pending, and it must never land

	await run.markEnded({ status: "completed", stats: stats(9) });
	assertEquals((await storedStats(db, run.crawl.uid)).done, 9);
	assertEquals(run.crawl.stats.done, 9);

	await delay(THROTTLE * 2);
	assertEquals(seen, [1], "a trailing flush fired after the crawl ended");
	assertEquals(
		(await storedStats(db, run.crawl.uid)).done,
		9,
		"the terminal snapshot was clobbered by a stale one",
	);
});

pgTest("markEnded without stats keeps the snapshot the throttle was holding", async (
	{ run, db },
) => {
	await run.progress(stats(1));
	await run.progress(stats(5));

	await run.markEnded({ status: "stopped", stoppedBy: "maxPages" });
	assertEquals((await storedStats(db, run.crawl.uid)).done, 5);
	assertEquals(run.crawl.status, "stopped");
});

pgTest("a failing progress write is logged and swallowed", async (
	{ run, db, seen, logger },
) => {
	// leading edge and trailing flush both fail; neither may reject or go unhandled
	await run.progress(stats(1));
	await run.progress(stats(2));

	assert(
		logger.messages("warn").some((m) => m.includes("progress write failed")),
		logger.messages("warn").join("\n") || "(nothing was logged)",
	);
	await waitFor(() => Promise.resolve(seen.length === 2), "the trailing flush to fail");
	await delay(THROTTLE);
	assertEquals(logger.messages("warn").length, 2);
	assertEquals(
		await storedStats(db, run.crawl.uid),
		{},
		"a failed write reached the row anyway",
	);
}, { failWrites: true });

pgTest("two handles on one CrawlerPg do not share a throttle window", async (
	{ run, newRun, db, seen },
) => {
	const other = await newRun();

	await run.progress(stats(1));
	await other.progress(stats(2));

	assertEquals(seen, [1, 2], "the second handle was throttled by the first");
	assertEquals((await storedStats(db, run.crawl.uid)).done, 1);
	assertEquals((await storedStats(db, other.crawl.uid)).done, 2);
});
