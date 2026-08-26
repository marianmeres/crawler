/**
 * Crash-resume: what a *second* invocation of the handler does with the crawl the first
 * one left behind.
 *
 * The whole point of job mode is that steve's retry is not a restart. So every test here
 * runs the handler more than once against the same PG state, and the load-bearing
 * assertion is always the fixture's call log: a page the dead attempt already paid for
 * must not be fetched again.
 *
 * The failure-semantics half of the same task is asserted at the end: a site full of dead
 * pages produces a *completed* job, because a page that fails is data, not an error.
 *
 * @module
 */

import { assert, assertEquals, assertFalse, assertRejects } from "@std/assert";
import type { Job } from "@marianmeres/steve";
import type { FetchFn } from "@marianmeres/page-fetcher";
import { createPg } from "./_pg.ts";
import type { MiniSite, RecordingFetch } from "./_helpers.ts";
import { SITE, siteFetch, SMALL_SITE } from "./_helpers.ts";
import { createCrawlJobHandler } from "../src/steve/mod.ts";
import type { CrawlJobResult } from "../src/steve/mod.ts";
import { type CrawlerPg, createCrawlerPg } from "../src/pg/mod.ts";

const hasPg = !!Deno.env.get("TEST_PG_DATABASE");

const TEST_PREFIX = "_test_steve_resume_";
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
 * Every page but the entry point (and the `robots.txt` that precedes it) made slow, so
 * that an attempt killed right after the home page has demonstrably not started on the
 * rest of the site.
 */
const SLOW_SITE: MiniSite = Object.fromEntries(
	Object.entries(SMALL_SITE).map(([url, page]) => [
		url,
		url === HOME || url === `${SITE}/robots.txt` ? page : { ...page, delayMs: 5_000 },
	]),
);

function makeJob(payload: Record<string, unknown>, over: Partial<Job> = {}): Job {
	return {
		uid: crypto.randomUUID(),
		attempts: 1,
		payload,
		tenant_id: null,
		...over,
	} as Job;
}

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

/**
 * A transport whose site can be swapped between attempts, so each attempt gets its own
 * call log — `transport.calls` is then literally "what this attempt fetched".
 */
function swappableFetch(initial: MiniSite): {
	fetcher: FetchFn;
	serve(site: MiniSite): RecordingFetch;
} {
	let current = siteFetch(initial);
	return {
		fetcher: (req) => current(req),
		serve(site) {
			current = siteFetch(site);
			return current;
		},
	};
}

// -----------------------------------------------------------------------------------

pgTest("a retried attempt resumes the crawl instead of restarting it", async ({
	crawlerPg,
	db,
}) => {
	const transport = swappableFetch(SLOW_SITE);
	const controller = new AbortController();

	const handler = createCrawlJobHandler({
		db,
		pg: { tablePrefix: TEST_PREFIX, progressThrottleMs: 0 },
		fetcher: transport.fetcher,
		baseOptions: {
			concurrency: 1,
			perHostConcurrency: 1,
			maxPages: 100,
			events: {
				// steve's attempt timeout, landing the moment the home page is done
				onPageDone: () => {
					if (!controller.signal.aborted) controller.abort();
				},
			},
		},
	});

	// --- attempt 1: dies one page in ---------------------------------------------------
	const job = makeJob({ seeds: [HOME] });
	await assertRejects(() => handler(job, controller.signal) as Promise<unknown>);

	const crashed = (await crawlerPg.getCrawlByJobUid(job.uid))!;
	assertEquals(crashed.status, "failed");
	assertEquals((await crawlerPg.listPages(crashed.uid)).map((p) => p.url), [HOME]);

	// --- attempt 2: same job, no signal, and it finishes the crawl ----------------------
	const second = transport.serve(SMALL_SITE);
	job.attempts = 2;
	const result = await handler(job) as CrawlJobResult;

	assertEquals(result.crawlUid, crashed.uid, "the retry started a second crawl");
	assertEquals(result.resumed, true);
	assertEquals(result.attempt, 2);
	assertEquals(result.stoppedBy, "completed");
	assertEquals((await crawlerPg.listCrawls()).length, 1);

	// the page attempt 1 paid for was not paid for twice — robots.txt is re-read, since
	// only the frontier, the visited set and the pages are durable
	assertFalse(
		second.calls.some((call) => call.url === HOME),
		"a page the crashed attempt had already fetched was fetched again",
	);
	assert(second.calls.some((call) => call.url === `${SITE}/a`));

	// --- and the crawl, not the attempt, is what the numbers describe -------------------
	const pages = await crawlerPg.listPages(crashed.uid);
	assertEquals(pages.map((p) => p.url).sort(), [...EXPECTED_URLS].sort());
	assertEquals(result.stats.done, EXPECTED_URLS.length);
	assertEquals(result.stats.failed, 0);
	assertEquals(result.stats.queued, 0);

	const row = (await crawlerPg.getCrawl(crashed.uid))!;
	assertEquals(row.status, "completed");
	assertEquals(row.stoppedBy, "completed");
	assertEquals(row.error, null);
	assertEquals(row.stats.done, EXPECTED_URLS.length);

	// --- attempt 3: nothing left to do, and it says so ----------------------------------
	const third = transport.serve(SMALL_SITE);
	job.attempts = 3;
	const again = await handler(job) as CrawlJobResult;

	assertEquals(third.calls, [], "a finished crawl was re-crawled");
	assertEquals(again.crawlUid, crashed.uid);
	assertEquals(again.resumed, true);
	assertEquals(again.attempt, 3);
	assertEquals(again.stoppedBy, "completed");
	assertEquals(again.stats.done, EXPECTED_URLS.length);
	assertEquals(JSON.parse(JSON.stringify(again)), again);
	// the stored summary was returned, not rewritten
	assertEquals((await crawlerPg.getCrawl(crashed.uid))!.stats, row.stats);
});

pgTest("payload.crawlUid hands an abandoned run to a new job", async ({
	crawlerPg,
	db,
}) => {
	const transport = swappableFetch(SLOW_SITE);
	const controller = new AbortController();

	const handler = createCrawlJobHandler({
		db,
		pg: { tablePrefix: TEST_PREFIX },
		fetcher: transport.fetcher,
		baseOptions: {
			concurrency: 1,
			perHostConcurrency: 1,
			maxPages: 100,
			events: {
				onPageDone: () => {
					if (!controller.signal.aborted) controller.abort();
				},
			},
		},
	});

	const reaped = makeJob({ seeds: [HOME] });
	await assertRejects(() => handler(reaped, controller.signal) as Promise<unknown>);
	const crawlUid = (await crawlerPg.getCrawlByJobUid(reaped.uid))!.uid;

	// the documented recovery for an expired job: a brand new job, pointed at the run
	transport.serve(SMALL_SITE);
	const recovery = makeJob({ seeds: [HOME], crawlUid });
	const result = await handler(recovery) as CrawlJobResult;

	assertEquals(result.crawlUid, crawlUid);
	assertEquals(result.resumed, true);
	assertEquals(result.stoppedBy, "completed");
	assertEquals((await crawlerPg.listCrawls()).length, 1);
	assertEquals(
		(await crawlerPg.listPages(crawlUid)).map((p) => p.url).sort(),
		[...EXPECTED_URLS].sort(),
	);
	// the back-reference follows the run: the expired job is no longer the way in
	assertEquals((await crawlerPg.getCrawl(crawlUid))!.jobUid, recovery.uid);
	assertEquals((await crawlerPg.getCrawlByJobUid(recovery.uid))!.uid, crawlUid);
	assertEquals(await crawlerPg.getCrawlByJobUid(reaped.uid), null);
});

pgTest("a payload.crawlUid that names no run throws rather than re-crawling", async ({
	crawlerPg,
	db,
}) => {
	const fetcher = siteFetch(SMALL_SITE);
	const handler = createCrawlJobHandler({
		db,
		pg: { tablePrefix: TEST_PREFIX },
		fetcher,
		baseOptions: { maxPages: 10 },
	});

	await assertRejects(
		() =>
			handler(
				makeJob({ seeds: [HOME], crawlUid: crypto.randomUUID() }),
			) as Promise<unknown>,
		Error,
		"names no crawl run",
	);

	assertEquals(await crawlerPg.listCrawls(), []);
	assertEquals(fetcher.calls, []);
});

pgTest("an attempt whose predecessor never wrote a row starts fresh", async ({
	crawlerPg,
	db,
}) => {
	const handler = createCrawlJobHandler({
		db,
		pg: { tablePrefix: TEST_PREFIX },
		fetcher: siteFetch(SMALL_SITE),
		baseOptions: { concurrency: 1, maxPages: 100 },
	});

	// attempt 1 died before its INSERT, so the lookup by job_uid finds nothing
	const result = await handler(
		makeJob({ seeds: [HOME] }, { attempts: 2 }),
	) as CrawlJobResult;

	assertEquals(result.resumed, false);
	assertEquals(result.attempt, 2);
	assertEquals(result.stoppedBy, "completed");
	assertEquals(result.stats.done, EXPECTED_URLS.length);
	assertEquals((await crawlerPg.listCrawls()).length, 1);
});

// -----------------------------------------------------------------------------------

/** Two dead pages and no `robots.txt` — everything that can go wrong per page. */
const BROKEN_SITE: MiniSite = {
	[HOME]: {
		html: `<title>Home</title>
			<a href="/gone">gone</a>
			<a href="/boom">boom</a>`,
	},
	[`${SITE}/gone`]: { status: 500, html: "server is unwell" },
	[`${SITE}/boom`]: { error: { kind: "network", message: "connection reset" } },
	[`${SITE}/robots.txt`]: { status: 404 },
};

pgTest("a page that fails is a row and a counter, never a failed job", async ({
	crawlerPg,
	db,
}) => {
	const handler = createCrawlJobHandler({
		db,
		pg: { tablePrefix: TEST_PREFIX },
		fetcher: siteFetch(BROKEN_SITE),
		baseOptions: { concurrency: 1, perHostConcurrency: 1, maxPages: 100 },
	});

	const result = await handler(makeJob({ seeds: [HOME] })) as CrawlJobResult;

	// the job completes: steve retries what the crawler could not do, not what the site
	// could not answer
	assertEquals(result.stoppedBy, "completed");
	assertEquals(result.stats.done, 1);
	assertEquals(result.stats.failed, 2);

	const row = (await crawlerPg.getCrawl(result.crawlUid))!;
	assertEquals(row.status, "completed");
	assertEquals(row.error, null);
	assertEquals(
		(await crawlerPg.listFailed(result.crawlUid)).map((p) => p.url).sort(),
		[`${SITE}/boom`, `${SITE}/gone`],
	);
});
