/**
 * `CrawlerPg`'s factory and crawl-row lifecycle against a live server.
 *
 * The same body runs twice, once over a `pg.Pool` and once over a `pg.Client`, because
 * both are in the injected-connection contract and only the Pool path is exercised
 * incidentally by the rest of the suite.
 *
 * Gated on `TEST_PG_DATABASE` only: with the variable set but the server unreachable
 * these tests fail rather than skip.
 *
 * @module
 */

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import type pg from "pg";
import { createPg, createPgClient } from "./_pg.ts";
import { CrawlerPg, createCrawlerPg, DEFAULT_TENANT_ID } from "../src/pg/mod.ts";
import type { CrawlStats } from "../src/mod.ts";

const hasPg = !!Deno.env.get("TEST_PG_DATABASE");

const TEST_PREFIX = "_test_lifecycle_";

const SEEDS = ["https://example.com/", "https://example.com/about"];
const OPTIONS = { maxPages: 10, scope: { mode: "same-host" } };

function stats(crawlId: string, done: number): CrawlStats {
	return {
		crawlId,
		queued: 0,
		inFlight: 0,
		done,
		failed: 0,
		skipped: 0,
		bytes: 1234,
		startedAt: Date.now(),
		elapsed: 42,
		pagesPerSecond: 1,
		byStatus: { 200: done },
		skippedByReason: {},
	};
}

/** Everything the Done-when criterion names, over whichever connection kind. */
async function assertLifecycle(db: pg.Pool | pg.Client): Promise<void> {
	const crawlerPg = createCrawlerPg({ db, tablePrefix: TEST_PREFIX });
	try {
		// there is no ledger: a reset is a drop + recreate, and it converges
		await crawlerPg.resetHard();
		await crawlerPg.resetHard();

		const run = await crawlerPg.createCrawl({ seeds: SEEDS, options: OPTIONS });
		assertEquals(run.crawl.status, "pending");
		assertEquals(run.crawl.seeds, SEEDS);
		assertEquals(run.crawl.options, OPTIONS);
		assertEquals(run.crawl.tenantId, DEFAULT_TENANT_ID);
		assertEquals(run.crawl.stats, {});
		assertEquals(run.crawl.startedAt, null);
		assertEquals(run.crawl.endedAt, null);
		assert(run.crawl.uid, "createCrawl minted no uid");

		const reopened = await crawlerPg.openCrawl(run.crawl.uid);
		assertEquals(reopened.crawl.id, run.crawl.id);
		assertEquals(reopened.crawl.uid, run.crawl.uid);
		assertEquals(reopened.crawl.seeds, SEEDS);
		assertEquals(reopened.crawl.options, OPTIONS);

		await run.markRunning();
		assertEquals(run.crawl.status, "running");
		const startedAt = run.crawl.startedAt;
		assert(startedAt instanceof Date, "markRunning stamped no started_at");

		// a resumed attempt reports the original start, not this one
		await run.markRunning();
		assertEquals(run.crawl.startedAt?.getTime(), startedAt.getTime());

		await run.markEnded({
			status: "completed",
			stoppedBy: "maxPages",
			stats: stats(run.crawl.uid, 7),
		});
		assertEquals(run.crawl.status, "completed");
		assertEquals(run.crawl.stoppedBy, "maxPages");
		assertEquals(run.crawl.stats.done, 7);
		assertEquals(run.crawl.stats.byStatus, { 200: 7 });
		assertEquals(run.crawl.error, null);
		assert(run.crawl.endedAt instanceof Date, "markEnded stamped no ended_at");
		assertEquals(run.crawl.startedAt?.getTime(), startedAt.getTime());

		// and the terminal state is what a fresh open sees
		assertEquals(
			(await crawlerPg.openCrawl(run.crawl.uid)).crawl.status,
			"completed",
		);

		await assertRejects(() => crawlerPg.openCrawl(crypto.randomUUID()));

		// tenant scoping: another tenant's instance cannot reach the row
		const other = createCrawlerPg({
			db,
			tablePrefix: TEST_PREFIX,
			tenantId: "other",
		});
		await assertRejects(() => other.openCrawl(run.crawl.uid));
	} finally {
		await crawlerPg.uninstall().catch(() => {});
	}
}

Deno.test({ name: "pg: crawl lifecycle over a pg.Pool", ignore: !hasPg }, async () => {
	const db = createPg();
	try {
		await assertLifecycle(db);
	} finally {
		await db.end();
	}
});

Deno.test({ name: "pg: crawl lifecycle over a pg.Client", ignore: !hasPg }, async () => {
	const db = createPgClient();
	await db.connect();
	try {
		await assertLifecycle(db);
	} finally {
		await db.end();
	}
});

Deno.test("CrawlerPg.__schema() renders the DDL for a prefix, without a connection", () => {
	const { create, drop } = CrawlerPg.__schema("myschema._test_");
	assert(create.includes("CREATE TABLE IF NOT EXISTS myschema._test___crawler_crawl"));
	assert(drop.includes("DROP TABLE IF EXISTS myschema._test___crawler_frontier"));
	// index names are never schema-qualified
	assert(create.includes("idx_myschema_test___crawler_crawl_uid"));
});

Deno.test("CrawlerPg refuses to construct without a connection", () => {
	assertThrows(
		// deno-lint-ignore no-explicit-any -- the point is an unchecked JS call site
		() => new CrawlerPg({} as any),
		TypeError,
	);
});
