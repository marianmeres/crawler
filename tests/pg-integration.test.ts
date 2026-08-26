/**
 * One whole crawl, end to end, into a live database — the pass the per-unit PG suites do
 * not make. They each exercise one writer against hand-built inputs; this one runs the
 * engine over `SMALL_SITE` with the PG stores driving it, persists every page through the
 * event a consumer would wire, and then asks the reporting API what happened.
 *
 * What that adds is agreement between the halves: the depths and `discoveredVia` the
 * dispatcher assigned are the ones in `__crawler_page`, the edges it skipped are in
 * `__crawler_link` with their reasons, the frontier it popped from is fully acked, and the
 * archive holds one row per URL regardless of how many runs touched it. A unit test can
 * assert each of those against a fixture it wrote itself; only a crawl can show that the
 * two sides mean the same thing.
 *
 * Still network-free: `siteFetch` serves the fixture site, only the database is real.
 * Gated on `TEST_PG_DATABASE` only — with the variable set but the server unreachable
 * these tests fail rather than skip.
 *
 * @module
 */

import { assert, assertEquals, assertFalse } from "@std/assert";
import { createPg } from "./_pg.ts";
import { SITE, siteFetch, SMALL_SITE } from "./_helpers.ts";
import { crawl } from "../src/crawler.ts";
import {
	type CrawlerPg,
	type CrawlPersistence,
	type CrawlStatus,
	createCrawlerPg,
} from "../src/pg/mod.ts";
import type { CrawlOptions, CrawlReport, DiscoveredVia, FetchFn } from "../src/types.ts";

const hasPg = !!Deno.env.get("TEST_PG_DATABASE");

const TEST_PREFIX = "_test_integration_";
const TABLE_URL = `${TEST_PREFIX}__crawler_url`;
const TABLE_FRONTIER = `${TEST_PREFIX}__crawler_frontier`;

const decoder = new TextDecoder();

const HOME = `${SITE}/`;
const REDIRECT = `${SITE}/redirect`;
const TARGET = `${SITE}/target`;
const DUP = `${SITE}/dup`;

/**
 * What a `robots.sitemaps` crawl of the fixture site reaches, and how it got there.
 *
 * The two depth-0 entries are the point of crawling with robots on: `/` is the seed and
 * `/sitemap-only` is linked from nowhere, so it can only have arrived through the
 * `Sitemap:` line — and `/private/secret`, which the markup does link, is absent because
 * `/robots.txt` disallows it.
 */
const EXPECTED_PAGES: [url: string, depth: number, via: DiscoveredVia][] = [
	[HOME, 0, "seed"],
	[`${SITE}/sitemap-only`, 0, "sitemap"],
	[`${SITE}/a`, 1, "link"],
	[`${SITE}/b`, 1, "link"],
	[DUP, 1, "link"],
	[REDIRECT, 1, "link"],
	[`${SITE}/t/a/b/a/b/a/b`, 1, "link"],
];

/**
 * Every URL the run records as visited: the pages above plus the redirect destination,
 * which is marked visited without ever becoming an item of its own.
 */
const EXPECTED_VISITED = [...EXPECTED_PAGES.map(([url]) => url), TARGET];

/** The bytes the fixture serves for `url` — a redirect answers with its target's page. */
function html(url: string): string {
	return SMALL_SITE[url === REDIRECT ? TARGET : url].html!;
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
		const crawlerPg = createCrawlerPg({
			db,
			tablePrefix: TEST_PREFIX,
			// every progress call writes: the throttle is T24's subject, and a window here
			// would only decide which snapshot a later assertion happens to see
			progressThrottleMs: 0,
		});
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
 * One crawl of the fixture site into one crawl row, wired the way a consumer wires it:
 * the durable stores drive the run, `onPageDone` persists, `onProgress` publishes.
 *
 * Both of those are *events*, so the engine does not await them — the `persistPage` writes
 * they start are collected here and awaited before the report is handed back, which is
 * what makes the assertions that follow deterministic.
 */
async function runCrawl(
	run: CrawlPersistence,
	fetcher: FetchFn,
	options: CrawlOptions = {},
): Promise<CrawlReport> {
	const written: Promise<void>[] = [];
	await run.markRunning();

	const report = await crawl(HOME, {
		fetcher,
		stores: run.stores,
		robots: { sitemaps: true },
		// one worker: the pop order, and therefore every row order below, is the fixture's
		concurrency: 1,
		perHostConcurrency: 1,
		progressInterval: 0,
		...options,
		events: {
			onPageDone: (res, ctx) => void written.push(run.persistPage(res, ctx)),
			onProgress: (stats) => void written.push(run.progress(stats)),
		},
	});

	await Promise.all(written);
	await run.markEnded({
		status: "completed",
		stoppedBy: report.stoppedBy,
		stats: report.stats,
	});
	return report;
}

// -----------------------------------------------------------------------------------

pgTest("a whole crawl of the fixture site lands in PG", async (t) => {
	const { crawlerPg, db } = t;
	const fetcher = siteFetch(SMALL_SITE);
	const run = await crawlerPg.createCrawl({
		seeds: [HOME],
		options: { robots: { sitemaps: true } },
	});
	const uid = run.crawl.uid;

	assertEquals(run.crawl.status, "pending");
	assertEquals(run.crawl.seeds, [HOME]);
	assertEquals(run.crawl.stats, {});
	assertEquals(run.crawl.startedAt, null);

	const report = await runCrawl(run, fetcher);

	// --- the crawl row -------------------------------------------------------------
	const row = (await crawlerPg.getCrawl(uid))!;
	assertEquals(row.status, "completed");
	assertEquals(row.stoppedBy, "completed");
	assertEquals(row.error, null);
	assert(row.startedAt instanceof Date, "markRunning stamped no started_at");
	assert(row.endedAt instanceof Date, "markEnded stamped no ended_at");
	assert(row.endedAt >= row.startedAt);
	// the JSONB survived the round trip whole, counters included
	assertEquals(row.stats, JSON.parse(JSON.stringify(report.stats)));
	assertEquals(row.stats.done, EXPECTED_PAGES.length);
	assertEquals(row.stats.failed, 0);
	assertEquals(row.stats.queued, 0);
	assertEquals(row.stats.byStatus, { 200: EXPECTED_PAGES.length });
	assertEquals(row.stats.skippedByReason, {
		"robots-disallow": 1,
		"out-of-scope": 1,
		duplicate: 4,
	});

	// --- the page rows ---------------------------------------------------------------
	const pages = await crawlerPg.listPages(uid);
	assertEquals(
		pages.map((p) => [p.url, p.depth, p.discoveredVia]),
		EXPECTED_PAGES,
	);
	assertEquals(pages.map((p) => p.url), report.pages.map((p) => p.url));
	for (const page of pages) {
		assertEquals(page.crawlId, run.crawl.id);
		assertEquals(page.status, 200);
		assertEquals(page.ok, true);
		assertEquals(page.notModified, false);
		assertEquals(page.contentType, "text/html");
		assertEquals(page.errorKind, null);
		assertEquals(page.skipReason, null);
		assertEquals(
			page.contentHash,
			report.pages.find((p) => p.url === page.url)!.contentHash,
		);
		// depth-1 pages all hang off the seed; the two depth-0 ones have no referrer
		assertEquals(page.referrer, page.depth === 0 ? null : HOME);
	}
	// the redirect is an attribute of its page, never a page of its own
	assertEquals(pages.find((p) => p.url === REDIRECT)!.finalUrl, TARGET);
	assertFalse(pages.some((p) => p.url === TARGET));
	// and neither robots.txt nor the sitemap is a page, though both were fetched
	assert(fetcher.calls.some((c) => c.url === `${SITE}/robots.txt`));
	assertFalse(pages.some((p) => p.url.endsWith(".txt") || p.url.endsWith(".xml")));

	// --- the link rows ---------------------------------------------------------------
	const links = await crawlerPg.listLinks(uid);
	assertEquals(
		links.map((l) => [l.fromUrl, l.toUrl, l.followed, l.skipReason]),
		report.graph.map((e) => [e.from, e.to, e.followed, e.skipReason ?? null]),
	);
	// the skipped edges are the reason the graph is stored at all: what the crawl chose
	// not to follow, and why, is only visible here
	assertEquals(
		links.filter((l) => !l.followed).map((l) => [l.toUrl, l.skipReason]),
		[
			[`${SITE}/private/secret`, "robots-disallow"],
			["http://ext.test/x", "out-of-scope"],
			[`${SITE}/b`, "duplicate"],
			[HOME, "duplicate"],
			[`${SITE}/a`, "duplicate"],
			[DUP, "duplicate"],
		],
	);
	assertEquals(
		links.find((l) => l.toUrl === "http://ext.test/x")!.kind,
		"external",
	);
	assertEquals(
		(await crawlerPg.listLinks(uid, { followed: true })).length,
		links.filter((l) => l.followed).length,
	);

	// --- the archive -----------------------------------------------------------------
	for (const [url] of EXPECTED_PAGES) {
		const archived = await crawlerPg.getBody(url);
		assert(archived !== null, `${url} archived no body`);
		assertEquals(decoder.decode(archived.body), html(url));
		assertEquals(archived.contentType, "text/html");
		assertEquals(archived.charset, "utf-8");
		assertEquals(
			archived.contentHash,
			pages.find((p) => p.url === url)!.contentHash,
		);
	}
	// the redirect destination is archived as visited, with no bytes: it was never fetched
	assertEquals(await crawlerPg.getBody(TARGET), null);
	assertEquals((await run.getValidators(TARGET))!.hasBody, false);
	assertEquals(
		(await db.query(`SELECT url FROM ${TABLE_URL} ORDER BY url`)).rows
			.map((r) => r.url)
			.sort(),
		[...EXPECTED_VISITED].sort(),
	);

	// --- the frontier ----------------------------------------------------------------
	const { rows: frontier } = await db.query(
		`SELECT url, status FROM ${TABLE_FRONTIER} WHERE crawl_id = $1 ORDER BY url`,
		[run.crawl.id],
	);
	assertEquals(frontier.map((f) => f.url), [...EXPECTED_VISITED].sort());
	assertEquals(frontier.filter((f) => f.status !== "done"), []);
	assertEquals(await run.stores.frontier.size(), 0);
	assertEquals(await run.stores.visited.count(), EXPECTED_VISITED.length);
});

pgTest("a running crawl publishes stats a second reader can watch", async ({
	crawlerPg,
}) => {
	const run = await crawlerPg.createCrawl({ seeds: [HOME] });
	const uid = run.crawl.uid;

	assertEquals((await crawlerPg.getCrawl(uid))!.status, "pending");
	assertEquals(await crawlerPg.crawlStats(uid), {});

	// `onPage` is a hook, so the engine awaits it: the read below cannot race the write
	// above, which is what makes a mid-crawl observation assertable at all
	const seen: { status: CrawlStatus; done: number }[] = [];
	const report = await runCrawl(run, siteFetch(SMALL_SITE), {
		onPage: async (_res, ctx) => {
			await run.progress(ctx.stats);
			const row = (await crawlerPg.getCrawl(uid))!;
			seen.push({ status: row.status, done: row.stats.done ?? -1 });
			return undefined;
		},
	});

	assertEquals(seen.length, report.pages.length);
	// running for the whole run, and the counter climbs while it does — one worker, so
	// the page being handled is the only one not yet counted
	assertEquals(seen.map((s) => s.status), seen.map(() => "running"));
	assertEquals(seen.map((s) => s.done), [0, 1, 2, 3, 4, 5, 6]);

	assertEquals((await crawlerPg.getCrawl(uid))!.status, "completed");
	assertEquals((await crawlerPg.crawlStats(uid))!.done, report.pages.length);
});

pgTest("a second run keeps its own rows and refreshes the shared archive", async ({
	crawlerPg,
	db,
}) => {
	// a shallow copy: `SMALL_SITE` is shared with every other suite in the process
	const site = { ...SMALL_SITE };

	const run1 = await crawlerPg.createCrawl({ seeds: [HOME] });
	const report1 = await runCrawl(run1, siteFetch(site));

	site[DUP] = { html: `<title>Dup, rewritten</title>` };

	const run2 = await crawlerPg.createCrawl({ seeds: [HOME] });
	const report2 = await runCrawl(run2, siteFetch(site));

	assertEquals((await crawlerPg.listCrawls()).length, 2);
	// page and link rows are per run — the second crawl added its own, it did not edit
	// the first one's
	for (const [uid, count] of [[run1.crawl.uid, 7], [run2.crawl.uid, 7]] as const) {
		assertEquals((await crawlerPg.listPages(uid)).length, count);
	}
	assertEquals(
		(await crawlerPg.listPages(run1.crawl.uid)).map((p) => p.contentHash),
		report1.pages.map((p) => p.contentHash ?? null),
	);

	// the archive is not: one row per URL, holding the latest bytes
	assertEquals(
		(await db.query(`SELECT count(*)::int AS c FROM ${TABLE_URL}`)).rows[0].c,
		EXPECTED_VISITED.length,
	);
	assertEquals(
		decoder.decode((await crawlerPg.getBody(DUP))!.body),
		`<title>Dup, rewritten</title>`,
	);
	assertEquals(decoder.decode((await crawlerPg.getBody(HOME))!.body), html(HOME));

	// and the two runs diff to exactly the page that changed
	assertEquals(await crawlerPg.listChanged(run2.crawl.uid), [
		{
			url: DUP,
			change: "changed",
			contentHash: report2.pages.find((p) => p.url === DUP)!.contentHash!,
			previousHash: report1.pages.find((p) => p.url === DUP)!.contentHash!,
		},
	]);
});
