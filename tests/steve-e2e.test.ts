/**
 * The one suite where steve drives.
 *
 * Everywhere else the handler is called directly, which is honest about the payload
 * contract but proves nothing about the queue: that a `startCrawlJob` payload survives the
 * JSONB column, that a started worker claims the job and routes it to the crawl handler
 * rather than to steve's noop fallback, and that the summary the handler returns is what
 * ends up in `__job.result`. This runs the whole loop — enqueue → claim → crawl → summary —
 * against a real `Jobs` instance on a real database.
 *
 * It is also where owner decision 3 becomes executable: bodies must never reach steve's
 * JSONB. The direct-invocation suites can only inspect the returned object; here the
 * assertion is made against the row PG actually stored.
 *
 * Only the queue and the database are real — the transport is still the fixture site. And
 * only terminal state is asserted: this crawl finishes in milliseconds, so any claim about
 * an intermediate `running` would be a race with the worker, not a test.
 *
 * @module
 */

import { assert, assertEquals, assertFalse } from "@std/assert";
import { Jobs } from "@marianmeres/steve";
import { createPg } from "./_pg.ts";
import { recordingLogger, SITE, siteFetch, SMALL_SITE } from "./_helpers.ts";
import {
	CRAWL_JOB_TYPE,
	createCrawlJobHandler,
	startCrawlJob,
} from "../src/steve/mod.ts";
import type { CrawlJobResult } from "../src/steve/mod.ts";
import { createCrawlerPg } from "../src/pg/mod.ts";

const hasPg = !!Deno.env.get("TEST_PG_DATABASE");

/** Shared by both schemas: steve owns `__job*`, the crawler owns `__crawler_*`. */
const TEST_PREFIX = "_test_steve_e2e_";
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

const TERMINAL = ["completed", "failed", "expired"];

/**
 * Poll `read` until `done` accepts what it returns, or fail after 15 seconds.
 *
 * A worker's timing is not a schedule: how soon after `start()` the job is claimed depends
 * on the poll interval and on the database, so the only sound way to wait for it is to ask
 * repeatedly.
 */
async function until<T>(
	read: () => Promise<T>,
	done: (value: T) => boolean,
	what: string,
): Promise<T> {
	const deadline = Date.now() + 15_000;
	for (;;) {
		const value = await read();
		if (done(value)) return value;
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

Deno.test({
	name: "pg: a crawl enqueued as a steve job is claimed, run and summarized",
	ignore: !hasPg,
}, async () => {
	const db = createPg();
	const fetcher = siteFetch(SMALL_SITE);
	const logger = recordingLogger();
	const crawlerPg = createCrawlerPg({ db, tablePrefix: TEST_PREFIX });

	const jobs = new Jobs({
		db,
		tablePrefix: TEST_PREFIX,
		pollTimeoutMs: 100,
		gracefulSigterm: false,
		logger,
		jobHandlers: {
			[CRAWL_JOB_TYPE]: createCrawlJobHandler({
				db,
				pg: { tablePrefix: TEST_PREFIX, progressThrottleMs: 0 },
				fetcher,
				baseOptions: { concurrency: 1, perHostConcurrency: 1, maxPages: 100 },
				logger,
			}),
		},
	});

	try {
		await crawlerPg.resetHard();
		await jobs.resetHard();

		// `maxPages` here is the payload's, and lower than the handler's own — so the
		// snapshot below shows whether the payload really made the round trip
		const { uid } = await startCrawlJob(
			jobs,
			HOME,
			{ maxPages: 50 },
			// one attempt: a retry would paper over a handler that threw
			{ max_attempts: 1 },
		);
		assertEquals((await jobs.find(uid)).job.status, "pending");
		assertEquals(fetcher.calls, []);

		await jobs.start(1);

		const job = await until(
			async () => (await jobs.find(uid)).job,
			(j) => TERMINAL.includes(j.status),
			"the crawl job to reach a terminal state",
		);

		// --- the queue's view -------------------------------------------------------
		assertEquals(job.status, "completed");
		assertEquals(job.type, CRAWL_JOB_TYPE);
		assertEquals(job.attempts, 1);

		// --- what steve stored as the result ----------------------------------------
		// read back out of JSONB, not the object the handler returned
		const result = job.result as unknown as CrawlJobResult;
		assertEquals(
			Object.keys(result).sort(),
			["attempt", "crawlUid", "resumed", "stats", "stoppedBy"],
		);
		assertEquals(result.stoppedBy, "completed");
		assertEquals(result.attempt, 1);
		assertEquals(result.resumed, false);
		assertEquals(result.stats.done, EXPECTED_URLS.length);
		assertEquals(result.stats.failed, 0);
		assertEquals(result.stats.queued, 0);
		assertFalse("byHost" in result.stats);

		// decision 3, and this is the only place it can be checked against the database:
		// the job row carries counters, never a crawl. No markup, and not even a URL —
		// every page the crawl touched is addressed through `crawlUid` instead.
		const stored = JSON.stringify(result);
		assertFalse(stored.includes("<"), "markup reached the steve job result");
		assertFalse(stored.includes(SITE), "a page URL reached the steve job result");
		assert(
			stored.length < 1_000,
			`the job result is not a summary: ${stored.length}b`,
		);

		// --- the crawl's own tables, which is where everything else lives ------------
		const crawl = (await crawlerPg.getCrawlByJobUid(uid))!;
		assert(crawl, "the finished job has no crawl row to point at");
		assertEquals(crawl.uid, result.crawlUid);
		assertEquals(crawl.jobUid, uid);
		assertEquals(crawl.status, "completed");
		assertEquals(crawl.stoppedBy, "completed");
		assertEquals(crawl.seeds, [HOME]);
		assertEquals(crawl.stats.done, EXPECTED_URLS.length);
		// the payload's budget, not the handler's
		assertEquals(crawl.options.maxPages, 50);

		const pages = await crawlerPg.listPages(crawl.uid);
		assertEquals(pages.map((p) => p.url).sort(), [...EXPECTED_URLS].sort());
		assertEquals(pages.filter((p) => !p.ok), []);
		// the bodies the result deliberately omits
		assert((await crawlerPg.getBody(HOME)) !== null);
	} finally {
		await jobs.stop();
		await jobs.uninstall().catch(() => {});
		await crawlerPg.uninstall().catch(() => {});
		await db.end();
	}
});
