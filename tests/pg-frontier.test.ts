/**
 * The PostgreSQL stores against a live server: the claim/ack lifecycle of
 * `PgFrontierStore` and the cross-run archive behind `PgVisitedStore`.
 *
 * Two of these tests exist for concurrency rather than coverage — the parallel pop and
 * the `openCrawl` recovery are where a subtle bug would hide, and neither is observable
 * from a single-connection test.
 *
 * Gated on `TEST_PG_DATABASE` only: with the variable set but the server unreachable
 * these tests fail rather than skip.
 *
 * @module
 */

import { assert, assertEquals } from "@std/assert";
import { createPg } from "./_pg.ts";
import { type CrawlerPg, type CrawlPersistence, createCrawlerPg } from "../src/pg/mod.ts";
import type { FrontierItem } from "../src/stores/mod.ts";

const hasPg = !!Deno.env.get("TEST_PG_DATABASE");

const TEST_PREFIX = "_test_frontier_";
const TABLE_FRONTIER = `${TEST_PREFIX}__crawler_frontier`;
const TABLE_URL = `${TEST_PREFIX}__crawler_url`;
const TABLE_PAGE = `${TEST_PREFIX}__crawler_page`;

function item(url: string, over: Partial<FrontierItem> = {}): FrontierItem {
	return {
		url,
		host: new URL(url).hostname,
		depth: 0,
		priority: 0,
		seq: 0,
		discoveredVia: "seed",
		...over,
	};
}

/** One reset schema, one fresh crawl, one pool — torn down whatever the body does. */
function pgTest(
	name: string,
	fn: (ctx: {
		crawlerPg: CrawlerPg;
		run: CrawlPersistence;
		db: ReturnType<typeof createPg>;
	}) => Promise<void>,
): void {
	Deno.test({ name: `pg: ${name}`, ignore: !hasPg }, async () => {
		const db = createPg();
		const crawlerPg = createCrawlerPg({ db, tablePrefix: TEST_PREFIX });
		try {
			await crawlerPg.resetHard();
			const run = await crawlerPg.createCrawl({ seeds: ["https://a.test/"] });
			await fn({ crawlerPg, run, db });
		} finally {
			await crawlerPg.uninstall().catch(() => {});
			await db.end();
		}
	});
}

pgTest("frontier push dedups per crawl, and says so", async ({ crawlerPg, run }) => {
	const { frontier } = run.stores;
	const url = "https://a.test/one";

	assertEquals(await frontier.push(item(url)), true);
	assertEquals(await frontier.push(item(url)), false);
	assertEquals(await frontier.size(), 1);

	// the conflict target is (crawl_id, url): another run of the same site re-enqueues
	const second = await crawlerPg.createCrawl({ seeds: ["https://a.test/"] });
	assertEquals(await second.stores.frontier.push(item(url)), true);
	assertEquals(await second.stores.frontier.size(), 1);
	assertEquals(await frontier.size(), 1);
});

pgTest("frontier pops by (priority, insertion order)", async ({ run }) => {
	const { frontier } = run.stores;
	for (const [url, priority] of [["c", 2], ["a", 0], ["b", 1], ["a2", 0]] as const) {
		await frontier.push(item(`https://a.test/${url}`, { priority }));
	}

	const order: string[] = [];
	for (let i = 0; i < 4; i++) order.push((await frontier.pop())!.url);
	assertEquals(order, [
		"https://a.test/a",
		"https://a.test/a2",
		"https://a.test/b",
		"https://a.test/c",
	]);
	assertEquals(await frontier.pop(), undefined);
});

pgTest("frontier honours excludeHosts, empty or not", async ({ run }) => {
	const { frontier } = run.stores;
	await frontier.push(item("https://a.test/x", { priority: 0 }));
	await frontier.push(item("https://b.test/y", { priority: 1 }));

	// an empty list excludes nothing (the `cardinality(...) = 0` guard)
	assertEquals((await frontier.pop({ excludeHosts: [] }))!.url, "https://a.test/x");
	// a.test is in flight, b.test is excluded => nothing is eligible right now
	assertEquals(await frontier.pop({ excludeHosts: ["b.test"] }), undefined);
	assertEquals(await frontier.size(), 1);
	assertEquals((await frontier.pop())!.url, "https://b.test/y");
});

pgTest("frontier does not pop an item deferred into the future", async ({ run }) => {
	const { frontier } = run.stores;
	await frontier.push(
		item("https://a.test/later", { priority: 0, readyAt: Date.now() + 60_000 }),
	);
	await frontier.push(item("https://a.test/now", { priority: 1 }));

	// the deferred item sorts first and is still skipped
	assertEquals((await frontier.pop())!.url, "https://a.test/now");
	assertEquals(await frontier.pop(), undefined);
	assertEquals(await frontier.size(), 1);
});

pgTest("frontier ack and release move the claim as specified", async ({ run, db }) => {
	const { frontier } = run.stores;
	const status = async (url: string) => {
		const { rows } = await db.query(
			`SELECT status, claimed_at FROM ${TABLE_FRONTIER}
				WHERE crawl_id = $1 AND url = $2`,
			[run.crawl.id, url],
		);
		return rows[0];
	};

	await frontier.push(item("https://a.test/acked"));
	await frontier.push(item("https://a.test/released", { priority: 1 }));

	const claimed = (await frontier.pop())!;
	assertEquals(claimed.url, "https://a.test/acked");
	assertEquals((await status(claimed.url)).status, "in_flight");
	assert((await status(claimed.url)).claimed_at instanceof Date);
	assertEquals(await frontier.size(), 1);

	await frontier.ack(claimed.url);
	assertEquals((await status(claimed.url)).status, "done");
	assertEquals(await run.stores.visited.count(), 1);

	const released = (await frontier.pop())!;
	assertEquals(released.url, "https://a.test/released");
	await frontier.release(released.url);
	const back = await status(released.url);
	assertEquals(back.status, "pending");
	assertEquals(back.claimed_at, null);
	assertEquals((await frontier.pop())!.url, released.url);

	// deferred release: pending again, but not eligible yet
	await frontier.release(released.url, Date.now() + 60_000);
	assertEquals(await frontier.size(), 1);
	assertEquals(await frontier.pop(), undefined);

	// releasing what is not in flight is a no-op, not a resurrection
	await frontier.release(claimed.url);
	assertEquals((await status(claimed.url)).status, "done");
});

pgTest("concurrent pops on two connections never claim the same row", async (ctx) => {
	const { frontier } = ctx.run.stores;
	for (let i = 0; i < 6; i++) {
		await frontier.push(item(`https://a.test/${i}`, { priority: i }));
	}

	// a second pool = a second physical connection, so these really do race
	const otherDb = createPg();
	const otherPg = createCrawlerPg({ db: otherDb, tablePrefix: TEST_PREFIX });
	try {
		const other = await otherPg.openCrawl(ctx.run.crawl.uid);
		const claims = await Promise.all([
			frontier.pop(),
			other.stores.frontier.pop(),
			frontier.pop(),
			other.stores.frontier.pop(),
			frontier.pop(),
			other.stores.frontier.pop(),
		]);
		const urls = claims.map((c) => c?.url);
		assert(urls.every((u) => u !== undefined), `a pop came back empty: ${urls}`);
		assertEquals(new Set(urls).size, 6, `duplicate claim: ${urls}`);
		assertEquals(await frontier.size(), 0);
	} finally {
		await otherDb.end();
	}
});

pgTest("openCrawl returns in-flight rows to the queue", async ({ crawlerPg, run }) => {
	const { frontier } = run.stores;
	await frontier.push(item("https://a.test/a", { priority: 0 }));
	await frontier.push(item("https://a.test/b", { priority: 1 }));
	const abandoned = (await frontier.pop())!;
	assertEquals(await frontier.size(), 1);

	// what a crashed process leaves behind, the next open picks up
	const resumed = await crawlerPg.openCrawl(run.crawl.uid);
	assertEquals(await resumed.stores.frontier.size(), 2);
	assertEquals((await resumed.stores.frontier.pop())!.url, abandoned.url);
});

pgTest("frontier round-trips an item through push and pop", async ({ run }) => {
	const pushed = item("https://a.test/deep?q=1", {
		depth: 3,
		priority: 3,
		referrer: "https://a.test/",
		discoveredVia: "sitemap",
		meta: { tag: "x", n: 2 },
	});
	assertEquals(await run.stores.frontier.push(pushed), true);

	const popped = (await run.stores.frontier.pop())!;
	assertEquals(popped.url, pushed.url);
	assertEquals(popped.host, "a.test");
	assertEquals(popped.depth, 3);
	assertEquals(popped.priority, 3);
	assertEquals(popped.referrer, pushed.referrer);
	assertEquals(popped.discoveredVia, "sitemap");
	assertEquals(popped.meta, pushed.meta);
	// `seq` is the row id — the engine's insertion order, reproduced by the serial
	assert(popped.seq > 0, "pop returned no seq");
});

pgTest("visited round-trips a state, body and all", async ({ run, db }) => {
	const { visited, frontier } = run.stores;
	const url = "https://a.test/page";
	const crawledAt = Date.now();

	assertEquals(await visited.has(url), false);
	assertEquals(await visited.get(url), undefined);
	assertEquals(await visited.count(), 0);

	await visited.add(url, {
		status: 200,
		contentHash: "abc123",
		etag: `W/"v1"`,
		lastModified: "Wed, 21 Oct 2015 07:28:00 GMT",
		crawledAt,
		attempts: 1,
	});

	assertEquals(await visited.has(url), true);
	assertEquals(await visited.count(), 1);
	// a URL marked visited without ever being enqueued (a redirect hop) still blocks a
	// re-enqueue from another referrer
	assertEquals(await frontier.push(item(url)), false);

	assertEquals(await visited.get(url), {
		status: 200,
		contentHash: "abc123",
		etag: `W/"v1"`,
		lastModified: "Wed, 21 Oct 2015 07:28:00 GMT",
		crawledAt,
		// this store keeps bodies, but `add` never writes one
		hasBody: false,
	});

	// `attempts` is per-run and lives on the page row, so the join is what surfaces it
	await db.query(
		`INSERT INTO ${TABLE_PAGE} (tenant_id, crawl_id, url, attempts)
			VALUES ('_default', $1, $2, 3)`,
		[run.crawl.id, url],
	);
	assertEquals((await visited.get(url))?.attempts, 3);

	// and `hasBody` is the truth about the archive, unlike the memory store's constant
	await db.query(
		`UPDATE ${TABLE_URL} SET body = decode('cafe', 'hex') WHERE url = $1`,
		[url],
	);
	assertEquals((await visited.get(url))?.hasBody, true);

	// replace, not merge: a redirect intermediate's minimal record is the last word
	await visited.add(url, { status: 301, crawledAt });
	assertEquals(await visited.get(url), {
		status: 301,
		crawledAt,
		attempts: 3,
		hasBody: true,
	});
});

pgTest("visited is isolated per tenant", async ({ run, db }) => {
	const url = "https://a.test/page";
	await run.stores.visited.add(url, { status: 200, etag: `W/"v1"` });

	const otherTenant = createCrawlerPg({
		db,
		tablePrefix: TEST_PREFIX,
		tenantId: "other",
	});
	const otherRun = await otherTenant.createCrawl({ seeds: ["https://a.test/"] });

	assertEquals(await otherRun.stores.visited.get(url), undefined);
	assertEquals(await otherRun.stores.visited.has(url), false);
	assertEquals(await otherRun.stores.visited.count(), 0);
	// …and the archive row it writes is its own
	await otherRun.stores.visited.add(url, { status: 404 });
	assertEquals((await run.stores.visited.get(url))?.status, 200);
	assertEquals((await otherRun.stores.visited.get(url))?.status, 404);
});
