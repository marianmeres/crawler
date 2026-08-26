/**
 * The handler factory, driven the way steve drives it — except without steve.
 *
 * A `JobHandler` is a plain function, so every assertion here comes from calling the
 * produced handler with a hand-built `Job`. Only four of its fields are ever read (`uid`,
 * `attempts`, `payload`, `tenant_id`), which is what makes that substitution honest and
 * keeps the queue out of the picture: what is under test is the payload contract, the
 * merge rules and what lands in PG, not steve's claiming.
 *
 * The transport is the fixture site, so nothing here opens a socket; the database is real
 * and the suite skips silently without `TEST_PG_DATABASE`.
 *
 * @module
 */

import {
	assert,
	assertEquals,
	assertFalse,
	assertRejects,
	assertThrows,
} from "@std/assert";
import type { Job } from "@marianmeres/steve";
import { createPg } from "./_pg.ts";
import { recordingLogger, SITE, siteFetch, SMALL_SITE } from "./_helpers.ts";
import { createCrawlJobHandler } from "../src/steve/mod.ts";
import type { CrawlJobResult } from "../src/steve/mod.ts";
import { type CrawlerPg, createCrawlerPg } from "../src/pg/mod.ts";

const hasPg = !!Deno.env.get("TEST_PG_DATABASE");

const TEST_PREFIX = "_test_steve_handler_";
const HOME = `${SITE}/`;

/** What a crawl of the fixture site reaches with robots respected and sitemaps off. */
const EXPECTED_URLS = [
	HOME,
	`${SITE}/a`,
	`${SITE}/b`,
	`${SITE}/dup`,
	`${SITE}/redirect`,
	`${SITE}/t/a/b/a/b/a/b`,
];

/**
 * A `Job` with the four fields the handler reads. The rest of steve's row is never
 * touched, so it is asserted away rather than fabricated.
 */
function makeJob(payload: Record<string, unknown>, over: Partial<Job> = {}): Job {
	return {
		uid: crypto.randomUUID(),
		attempts: 1,
		payload,
		tenant_id: null,
		...over,
	} as Job;
}

/** One reset schema, one pool — torn down whatever the body does. */
function pgTest(
	name: string,
	fn: (ctx: {
		crawlerPg: CrawlerPg;
		db: ReturnType<typeof createPg>;
	}) => Promise<void>,
): void {
	Deno.test({ name: `pg: ${name}`, ignore: !hasPg }, async () => {
		const db = createPg();
		const crawlerPg = createCrawlerPg({ db, tablePrefix: TEST_PREFIX });
		try {
			await crawlerPg.resetHard();
			await fn({ crawlerPg, db });
		} finally {
			await crawlerPg.uninstall().catch(() => {});
			await db.end();
		}
	});
}

// -----------------------------------------------------------------------------------

pgTest("a crawl job runs the fixture site into PG and returns a small summary", async ({
	crawlerPg,
	db,
}) => {
	const fetcher = siteFetch(SMALL_SITE);
	const handler = createCrawlJobHandler({
		db,
		pg: { tablePrefix: TEST_PREFIX, progressThrottleMs: 0 },
		fetcher,
		// one worker: the pop order, and therefore the row order below, is the fixture's
		baseOptions: { concurrency: 1, perHostConcurrency: 1, maxPages: 100 },
	});

	const job = makeJob({ seeds: [HOME] });
	const result = await handler(job) as CrawlJobResult;

	// --- the summary -----------------------------------------------------------------
	assertEquals(result.stoppedBy, "completed");
	assertEquals(result.attempt, 1);
	assertEquals(result.resumed, false);
	assertEquals(result.stats.done, EXPECTED_URLS.length);
	assertEquals(result.stats.failed, 0);
	assertEquals(result.stats.queued, 0);

	// it is what steve will JSON.stringify into the job's result column
	assertEquals(JSON.parse(JSON.stringify(result)), result);
	// and it is a summary: no pages, no graph, no unbounded map, no bytes anywhere
	assertEquals(
		Object.keys(result).sort(),
		["attempt", "crawlUid", "resumed", "stats", "stoppedBy"],
	);
	assertFalse("byHost" in result.stats);
	const serialized = JSON.stringify(result);
	assertFalse(serialized.includes("<title>"), "a page body reached the job result");
	assertFalse(serialized.includes(`${SITE}/a`), "a page URL reached the job result");

	// --- the crawl row ---------------------------------------------------------------
	const row = (await crawlerPg.getCrawl(result.crawlUid))!;
	assertEquals(row.status, "completed");
	assertEquals(row.stoppedBy, "completed");
	assertEquals(row.error, null);
	assertEquals(row.jobUid, job.uid);
	assertEquals(row.seeds, [HOME]);
	assert(row.startedAt instanceof Date);
	assert(row.endedAt instanceof Date);
	// the snapshot is the merged serializable subset — the payload carried none of it
	assertEquals(row.options, { concurrency: 1, perHostConcurrency: 1, maxPages: 100 });
	assertEquals(row.stats.done, EXPECTED_URLS.length);

	// --- the pages -------------------------------------------------------------------
	// sorted: the page rows are written from an event the engine does not await, so which
	// of two concurrent inserts lands first is not the handler's promise to keep
	const pages = await crawlerPg.listPages(result.crawlUid);
	assertEquals(pages.map((p) => p.url).sort(), [...EXPECTED_URLS].sort());
	assertEquals(pages.filter((p) => !p.ok), []);
	// the bodies went to the archive, which is the whole reason they are not in the result
	assert((await crawlerPg.getBody(HOME)) !== null);
	// the job's own bridge back: steve knows the uid, `./pg` knows the crawl
	assertEquals((await crawlerPg.getCrawlByJobUid(job.uid))!.uid, result.crawlUid);
});

pgTest(
	"a payload budget beats a larger one from baseOptions",
	async ({ crawlerPg, db }) => {
		const fetcher = siteFetch(SMALL_SITE);
		const handler = createCrawlJobHandler({
			db,
			pg: { tablePrefix: TEST_PREFIX },
			fetcher,
			baseOptions: { concurrency: 1, perHostConcurrency: 1, maxPages: 100 },
		});

		const result = await handler(
			makeJob({ seeds: [HOME], options: { maxPages: 1 } }),
		) as CrawlJobResult;

		assertEquals(result.stoppedBy, "maxPages");
		assertEquals(result.stats.done, 1);
		assertEquals((await crawlerPg.listPages(result.crawlUid)).length, 1);
		// a budget stop is a crawl that ended early, not one that failed
		assertEquals((await crawlerPg.getCrawl(result.crawlUid))!.status, "stopped");
		assertEquals((await crawlerPg.getCrawl(result.crawlUid))!.options.maxPages, 1);
	},
);

pgTest(
	"an invalid payload throws before any row is written",
	async ({ crawlerPg, db }) => {
		const handler = createCrawlJobHandler({
			db,
			pg: { tablePrefix: TEST_PREFIX },
			fetcher: siteFetch(SMALL_SITE),
		});

		const invalid: Record<string, unknown>[] = [
			{},
			{ seeds: [] },
			{ seeds: HOME },
			{ seeds: [HOME, 42] },
			{ seeds: [HOME], options: [] },
			{ seeds: [HOME], options: { maxPages: "lots" } },
			{ seeds: [HOME], options: { scope: "same-host" } },
			{ seeds: [HOME], crawlUid: 7 },
		];

		for (const payload of invalid) {
			await assertRejects(
				() => handler(makeJob(payload)) as Promise<unknown>,
				TypeError,
				"[crawler/steve]",
			);
		}

		assertEquals(await crawlerPg.listCrawls(), []);
	},
);

pgTest(
	"an unknown payload key is a warning, not a failure",
	async ({ crawlerPg, db }) => {
		const logger = recordingLogger();
		const handler = createCrawlJobHandler({
			db,
			pg: { tablePrefix: TEST_PREFIX },
			fetcher: siteFetch(SMALL_SITE),
			baseOptions: { concurrency: 1, maxPages: 2 },
			logger,
		});

		const result = await handler(
			makeJob({
				seeds: [HOME],
				somethingNewer: true,
				options: { turboMode: true },
			}),
		) as CrawlJobResult;

		assertEquals((await crawlerPg.getCrawl(result.crawlUid))!.status, "stopped");
		assertEquals(
			logger.messages("warn").filter((m) => m.includes("ignoring unknown")),
			[
				"[crawler/steve] ignoring unknown payload keys: somethingNewer",
				"[crawler/steve] ignoring unknown payload.options keys: turboMode",
			],
		);
		// forward-compat means ignored, not smuggled through
		assertFalse("turboMode" in (await crawlerPg.getCrawl(result.crawlUid))!.options);
	},
);

pgTest("the missing-budget warning fires once per handler, not once per job", async ({
	db,
}) => {
	const logger = recordingLogger();
	const handler = createCrawlJobHandler({
		db,
		pg: { tablePrefix: TEST_PREFIX },
		fetcher: siteFetch(SMALL_SITE),
		baseOptions: { concurrency: 1 },
		logger,
	});

	await handler(makeJob({ seeds: [HOME] }));
	await handler(makeJob({ seeds: [HOME] }));

	assertEquals(
		logger.messages("warn").filter((m) => m.includes("no budget")).length,
		1,
	);

	// and a crawl that has one never warns at all
	const budgeted = recordingLogger();
	const withBudget = createCrawlJobHandler({
		db,
		pg: { tablePrefix: TEST_PREFIX },
		fetcher: siteFetch(SMALL_SITE),
		baseOptions: { concurrency: 1 },
		logger: budgeted,
	});
	await withBudget(makeJob({ seeds: [HOME], options: { maxPages: 1 } }));
	assertEquals(budgeted.messages("warn").filter((m) => m.includes("no budget")), []);
});

pgTest('a payload asking for "priority" falls back to bfs', async ({ crawlerPg, db }) => {
	const logger = recordingLogger();
	const handler = createCrawlJobHandler({
		db,
		pg: { tablePrefix: TEST_PREFIX },
		fetcher: siteFetch(SMALL_SITE),
		// no `priority` function on the code side, which is the whole point
		baseOptions: { concurrency: 1, maxPages: 2 },
		logger,
	});

	const result = await handler(
		makeJob({ seeds: [HOME], options: { strategy: "priority" } }),
	) as CrawlJobResult;

	assertEquals(
		logger.messages("warn").filter((m) => m.includes("falling back to bfs")).length,
		1,
	);
	// the crawl still ran, and the snapshot records what it actually used
	assertEquals(result.stats.done, 2);
	assertEquals((await crawlerPg.getCrawl(result.crawlUid))!.options.strategy, "bfs");
});

Deno.test("createCrawlJobHandler refuses to build without a connection", () => {
	assertThrows(
		// deno-lint-ignore no-explicit-any -- the point is the runtime guard, not the type
		() => createCrawlJobHandler({} as any),
		TypeError,
		"needs a `db`",
	);
});
