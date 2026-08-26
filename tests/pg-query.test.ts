/**
 * The consumer query API against a persisted fixture crawl: the readers, their filters,
 * the two cross-run reports (`brokenLinks`, `listChanged`), the job-mode lookup, the
 * stats rebuild and the one destructive method.
 *
 * The fixture is deliberately built through `persistPage` rather than by INSERT: what
 * these methods have to read correctly is what the writer actually produces, including
 * the corners a hand-written row would gloss over — a transport error with no status, a
 * 304 with no size, a skipped edge that never became a page.
 *
 * Gated on `TEST_PG_DATABASE` only: with the variable set but the server unreachable
 * these tests fail rather than skip.
 *
 * @module
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { createPg } from "./_pg.ts";
import { makeResult } from "./_helpers.ts";
import {
	type CrawlerPg,
	type CrawlerPgOptions,
	type CrawlPersistence,
	createCrawlerPg,
} from "../src/pg/mod.ts";
import type { LinkRecord, PageResult } from "../src/mod.ts";

const hasPg = !!Deno.env.get("TEST_PG_DATABASE");

const TEST_PREFIX = "_test_query_";
const TABLE_URL = `${TEST_PREFIX}__crawler_url`;
const TABLE_PAGE = `${TEST_PREFIX}__crawler_page`;
const TABLE_LINK = `${TEST_PREFIX}__crawler_link`;
const TABLE_FRONTIER = `${TEST_PREFIX}__crawler_frontier`;

const decoder = new TextDecoder();

const HOME = "https://a.test/";
const PAGE_A = "https://a.test/a";
const NOT_MODIFIED = "https://a.test/nm";
const GONE = "https://a.test/gone";
const BOOM = "https://a.test/boom";
const EXTERNAL = "https://b.test/x";

/** A complete {@linkcode PageResult} from the handful of fields a test cares about. */
function page(over: Partial<PageResult> & { url: string }): PageResult {
	return {
		crawlId: "test-crawl",
		requestId: "test-request",
		finalUrl: over.url,
		redirects: [],
		status: 200,
		ok: true,
		depth: 0,
		discoveredVia: "seed",
		attempts: 1,
		timing: { total: 10, fetch: 8, extract: 2 },
		fromCache: false,
		notModified: false,
		links: [],
		...over,
	};
}

function link(to: string, over: Partial<LinkRecord> = {}): LinkRecord {
	return {
		from: HOME,
		to,
		rawHref: to,
		kind: "internal",
		rel: "page",
		nofollow: false,
		followed: true,
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
	options: Omit<CrawlerPgOptions, "db" | "tablePrefix"> = {},
): void {
	Deno.test({ name: `pg: ${name}`, ignore: !hasPg }, async () => {
		const db = createPg();
		const crawlerPg = createCrawlerPg({ db, tablePrefix: TEST_PREFIX, ...options });
		try {
			await crawlerPg.resetHard();
			const run = await crawlerPg.createCrawl({ seeds: [HOME] });
			await fn({ crawlerPg, run, db });
		} finally {
			await crawlerPg.uninstall().catch(() => {});
			await db.end();
		}
	});
}

/**
 * Five pages, six edges and two live frontier rows — the shape every expectation below
 * is written against.
 *
 * | url        | status | ok    | note                                 |
 * |------------|--------|-------|--------------------------------------|
 * | `/`        | 200    | yes   | links to `/a`, `/gone`, `/boom`, ext |
 * | `/a`       | 200    | yes   | links to `/gone`                     |
 * | `/nm`      | 304    | yes   | not modified, no size                |
 * | `/gone`    | 404    | no    | linked from two pages                |
 * | `/boom`    | —      | no    | transport error, no status           |
 */
async function fixture(run: CrawlPersistence): Promise<void> {
	await run.persistPage(
		page({
			url: HOME,
			contentType: "text/html",
			charset: "utf-8",
			contentHash: "h-home",
			title: "Home",
			size: 100,
			discoveredVia: "seed",
			links: [
				link(PAGE_A),
				link(GONE),
				link(BOOM),
				link(EXTERNAL, {
					kind: "external",
					followed: false,
					skipReason: "out-of-scope",
					anchorText: "elsewhere",
				}),
			],
		}),
		{
			fetchResult: makeResult({
				url: HOME,
				body: "<html>home</html>",
				headers: {
					etag: `"home-1"`,
					"last-modified": "Wed, 21 Oct 2015 07:28:00 GMT",
				},
			}),
		},
	);

	await run.persistPage(
		page({
			url: PAGE_A,
			contentType: "text/html",
			contentHash: "h-a",
			title: "A",
			size: 10,
			depth: 1,
			referrer: HOME,
			discoveredVia: "link",
			links: [link(GONE, { from: PAGE_A })],
		}),
		{ fetchResult: makeResult({ url: PAGE_A, body: "<html>a</html>" }) },
	);

	await run.persistPage(
		page({ url: NOT_MODIFIED, status: 304, notModified: true, depth: 1 }),
		{ fetchResult: makeResult({ url: NOT_MODIFIED, status: 304, hasBody: false }) },
	);

	await run.persistPage(
		page({ url: GONE, status: 404, ok: false, size: 5, depth: 1 }),
		{ fetchResult: makeResult({ url: GONE, status: 404, body: "nope" }) },
	);

	await run.persistPage(
		page({
			url: BOOM,
			status: 0,
			ok: false,
			attempts: 3,
			depth: 1,
			error: { kind: "timeout", message: "took too long", retryable: true },
		}),
	);

	const { frontier } = run.stores;
	await frontier.push({
		url: "https://a.test/queued",
		host: "a.test",
		depth: 1,
		priority: 1,
		seq: 1,
		discoveredVia: "link",
	});
	await frontier.push({
		url: "https://a.test/claimed",
		host: "a.test",
		depth: 1,
		priority: 0,
		seq: 2,
		discoveredVia: "link",
	});
	await frontier.pop();
}

async function count(
	db: ReturnType<typeof createPg>,
	table: string,
	where = "",
	values: unknown[] = [],
): Promise<number> {
	const { rows } = await db.query(
		`SELECT count(*)::int AS c FROM ${table} ${where ? `WHERE ${where}` : ""}`,
		values,
	);
	return rows[0].c;
}

// ---------------------------------------------------------------------------------
// the crawl readers
// ---------------------------------------------------------------------------------

pgTest("getCrawl reads one crawl by uid, and nothing across tenants", async ({
	crawlerPg,
	run,
	db,
}) => {
	const found = await crawlerPg.getCrawl(run.crawl.uid);
	assertEquals(found?.id, run.crawl.id);
	assertEquals(found?.seeds, [HOME]);
	assertEquals(found?.status, "pending");
	assertEquals(await crawlerPg.getCrawl(crypto.randomUUID()), null);

	const otherTenant = createCrawlerPg({
		db,
		tablePrefix: TEST_PREFIX,
		tenantId: "other",
	});
	assertEquals(await otherTenant.getCrawl(run.crawl.uid), null);
});

pgTest(
	"listCrawls is newest first, and filters by status",
	async ({ crawlerPg, run }) => {
		const second = await crawlerPg.createCrawl({ seeds: ["https://b.test/"] });
		const third = await crawlerPg.createCrawl({ seeds: ["https://c.test/"] });
		await second.markEnded({ status: "completed" });

		assertEquals(
			(await crawlerPg.listCrawls()).map((c) => c.uid),
			[third.crawl.uid, second.crawl.uid, run.crawl.uid],
		);
		assertEquals(
			(await crawlerPg.listCrawls({ status: "completed" })).map((c) => c.uid),
			[second.crawl.uid],
		);
		assertEquals((await crawlerPg.listCrawls({ limit: 1 })).map((c) => c.uid), [
			third.crawl.uid,
		]);
		assertEquals(
			(await crawlerPg.listCrawls({ limit: 1, offset: 2 })).map((c) => c.uid),
			[
				run.crawl.uid,
			],
		);
	},
);

pgTest("getCrawlByJobUid finds a run by the job it ran under", async ({ crawlerPg }) => {
	const jobUid = crypto.randomUUID();
	const run = await crawlerPg.createCrawl({ seeds: [HOME], jobUid });

	const found = await crawlerPg.getCrawlByJobUid(jobUid);
	assertEquals(found?.uid, run.crawl.uid);
	assertEquals(found?.jobUid, jobUid);
	assertEquals(await crawlerPg.getCrawlByJobUid(crypto.randomUUID()), null);
});

pgTest("crawlStats reads the live snapshot column", async ({ crawlerPg, run }) => {
	assertEquals(await crawlerPg.crawlStats(run.crawl.uid), {});
	assertEquals(await crawlerPg.crawlStats(crypto.randomUUID()), null);

	await run.progress({
		crawlId: run.crawl.uid,
		queued: 2,
		inFlight: 1,
		done: 7,
		failed: 0,
		skipped: 3,
		bytes: 1234,
		startedAt: 1000,
		elapsed: 500,
		pagesPerSecond: 14,
		byStatus: { 200: 7 },
		skippedByReason: { "out-of-scope": 3 },
	});

	const stats = await crawlerPg.crawlStats(run.crawl.uid);
	assertEquals(stats?.done, 7);
	assertEquals(stats?.byStatus, { 200: 7 });
	assertEquals(stats?.skippedByReason, { "out-of-scope": 3 });
}, { progressThrottleMs: 0 });

// ---------------------------------------------------------------------------------
// pages and links
// ---------------------------------------------------------------------------------

pgTest("listPages returns every page in discovery order", async ({ crawlerPg, run }) => {
	await fixture(run);
	const pages = await crawlerPg.listPages(run.crawl.uid);

	assertEquals(pages.map((p) => p.url), [HOME, PAGE_A, NOT_MODIFIED, GONE, BOOM]);
	assertEquals(pages[0].title, "Home");
	assertEquals(pages[0].depth, 0);
	assertEquals(pages[0].discoveredVia, "seed");
	assertEquals(pages[0].contentHash, "h-home");
	assertEquals(pages[0].timing, { total: 10, fetch: 8, extract: 2 });
	assert(pages[0].urlId !== null);
	assertEquals(pages[1].referrer, HOME);
	assertEquals(pages[4].status, null);
	assertEquals(pages[4].errorKind, "timeout");
	assertEquals(pages[4].errorMessage, "took too long");
	assertEquals(pages[4].attempts, 3);
	assertEquals(pages[4].urlId, null);

	// an unknown crawl is empty, not an error
	assertEquals(await crawlerPg.listPages(crypto.randomUUID()), []);
});

pgTest("listPages filters on ok, status, notModified and skipped", async ({
	crawlerPg,
	run,
	db,
}) => {
	await fixture(run);
	const uid = run.crawl.uid;
	const urls = async (opts: Parameters<typeof crawlerPg.listPages>[1]) =>
		(await crawlerPg.listPages(uid, opts)).map((p) => p.url);

	assertEquals(await urls({ ok: true }), [HOME, PAGE_A, NOT_MODIFIED]);
	assertEquals(await urls({ ok: false }), [GONE, BOOM]);
	assertEquals(await urls({ status: 404 }), [GONE]);
	assertEquals(await urls({ status: [200, 304] }), [HOME, PAGE_A, NOT_MODIFIED]);
	assertEquals(await urls({ notModified: true }), [NOT_MODIFIED]);

	// nothing the writer produces carries a policy skip, so plant one
	await db.query(`UPDATE ${TABLE_PAGE} SET skip_reason = 'excluded' WHERE url = $1`, [
		PAGE_A,
	]);
	assertEquals(await urls({ skipped: true }), [PAGE_A]);
	assertEquals(await urls({ skipped: false }), [HOME, NOT_MODIFIED, GONE, BOOM]);
});

pgTest("listPages paginates, ordered by id", async ({ crawlerPg, run }) => {
	await fixture(run);
	const uid = run.crawl.uid;

	assertEquals((await crawlerPg.listPages(uid, { limit: 2 })).map((p) => p.url), [
		HOME,
		PAGE_A,
	]);
	assertEquals(
		(await crawlerPg.listPages(uid, { limit: 2, offset: 2 })).map((p) => p.url),
		[NOT_MODIFIED, GONE],
	);
	// over the hard cap is not an error, it is a cap
	assertEquals((await crawlerPg.listPages(uid, { limit: 5000 })).length, 5);
});

pgTest(
	"listFailed is the attempted-and-failed subset",
	async ({ crawlerPg, run, db }) => {
		await fixture(run);
		await db.query(
			`UPDATE ${TABLE_PAGE} SET skip_reason = 'excluded' WHERE url = $1`,
			[
				GONE,
			],
		);

		// GONE is not ok, but it now carries a policy skip — a skip is not a failure
		assertEquals(
			(await crawlerPg.listFailed(run.crawl.uid)).map((p) => p.url),
			[BOOM],
		);
	},
);

pgTest("listLinks returns the graph and filters it", async ({ crawlerPg, run }) => {
	await fixture(run);
	const uid = run.crawl.uid;
	const links = await crawlerPg.listLinks(uid);

	assertEquals(links.map((l) => [l.fromUrl, l.toUrl]), [
		[HOME, PAGE_A],
		[HOME, GONE],
		[HOME, BOOM],
		[HOME, EXTERNAL],
		[PAGE_A, GONE],
	]);
	assertEquals(links[3].kind, "external");
	assertEquals(links[3].followed, false);
	assertEquals(links[3].skipReason, "out-of-scope");
	assertEquals(links[3].anchorText, "elsewhere");
	assertEquals(links[0].rel, "page");

	const to = async (opts: Parameters<typeof crawlerPg.listLinks>[1]) =>
		(await crawlerPg.listLinks(uid, opts)).map((l) => l.toUrl);

	assertEquals(await to({ kind: "external" }), [EXTERNAL]);
	assertEquals(await to({ followed: false }), [EXTERNAL]);
	assertEquals(await to({ skipReason: "out-of-scope" }), [EXTERNAL]);
	assertEquals(await to({ rel: "page" }), [PAGE_A, GONE, BOOM, EXTERNAL, GONE]);
	assertEquals(
		(await crawlerPg.listLinks(uid, { toUrl: GONE })).map((l) => l.fromUrl),
		[HOME, PAGE_A],
	);
	assertEquals(await to({ limit: 2 }), [PAGE_A, GONE]);
});

pgTest("brokenLinks groups dead targets with the pages linking to them", async ({
	crawlerPg,
	run,
}) => {
	await fixture(run);
	const broken = await crawlerPg.brokenLinks(run.crawl.uid);

	// worst first: two referrers before one
	assertEquals(broken.length, 2);
	assertEquals(broken[0].toUrl, GONE);
	assertEquals(broken[0].status, 404);
	assertEquals(broken[0].errorKind, undefined);
	assertEquals(broken[0].fromUrls, [HOME, PAGE_A]);

	assertEquals(broken[1].toUrl, BOOM);
	assertEquals(broken[1].status, null);
	assertEquals(broken[1].errorKind, "timeout");
	assertEquals(broken[1].fromUrls, [HOME]);

	// the external link was never visited, so it cannot be reported either way
	assert(!broken.some((b) => b.toUrl === EXTERNAL));
});

// ---------------------------------------------------------------------------------
// the archive
// ---------------------------------------------------------------------------------

pgTest("getBody returns the archived bytes and their metadata", async ({
	crawlerPg,
	run,
}) => {
	await fixture(run);

	const archived = await crawlerPg.getBody(HOME);
	assert(archived);
	assertEquals(decoder.decode(archived.body), "<html>home</html>");
	assertEquals(archived.contentType, "text/html");
	assertEquals(archived.charset, "utf-8");
	assertEquals(archived.contentHash, "h-home");
	assertEquals(archived.etag, `"home-1"`);
	assertEquals(archived.lastModified, "Wed, 21 Oct 2015 07:28:00 GMT");
	assert(archived.fetchedAt instanceof Date);

	// a 404 has an archive row but never a body
	assertEquals(await crawlerPg.getBody(GONE), null);
	assertEquals(await crawlerPg.getBody("https://a.test/never-fetched"), null);
});

pgTest("getBody is tenant-scoped", async ({ crawlerPg, run, db }) => {
	await fixture(run);
	const otherTenant = createCrawlerPg({
		db,
		tablePrefix: TEST_PREFIX,
		tenantId: "other",
	});
	assertEquals(await otherTenant.getBody(HOME), null);
	assert(await crawlerPg.getBody(HOME));
});

// ---------------------------------------------------------------------------------
// the cross-run diff
// ---------------------------------------------------------------------------------

/** Two runs over the same three-ish URLs: one identical, one edited, one gone, one new. */
async function twoRuns(crawlerPg: CrawlerPg) {
	const first = await crawlerPg.createCrawl({ seeds: [HOME] });
	for (const [url, hash] of [["x", "h-x"], ["y", "h-y"], ["z", "h-z"]]) {
		await first.persistPage(
			page({ url: `https://a.test/${url}`, contentHash: hash }),
			{ fetchResult: makeResult({ url: `https://a.test/${url}`, body: hash }) },
		);
	}
	await first.markEnded({ status: "completed" });

	const second = await crawlerPg.createCrawl({ seeds: [HOME] });
	for (const [url, hash] of [["x", "h-x"], ["y", "h-y2"], ["w", "h-w"]]) {
		await second.persistPage(
			page({ url: `https://a.test/${url}`, contentHash: hash }),
			{ fetchResult: makeResult({ url: `https://a.test/${url}`, body: hash }) },
		);
	}
	return { first, second };
}

pgTest("listChanged diffs against an explicit baseline run", async ({ crawlerPg }) => {
	const { first, second } = await twoRuns(crawlerPg);

	const changed = await crawlerPg.listChanged(second.crawl.uid, {
		against: first.crawl.uid,
	});
	assertEquals(changed, [
		{ url: "https://a.test/w", change: "new", contentHash: "h-w" },
		{
			url: "https://a.test/y",
			change: "changed",
			contentHash: "h-y2",
			previousHash: "h-y",
		},
		{ url: "https://a.test/z", change: "removed", previousHash: "h-z" },
	]);

	await assertRejects(
		() => crawlerPg.listChanged(second.crawl.uid, { against: crypto.randomUUID() }),
		Error,
		"not found",
	);
});

pgTest("listChanged defaults to the previous completed run", async ({ crawlerPg }) => {
	const { second } = await twoRuns(crawlerPg);

	assertEquals(
		(await crawlerPg.listChanged(second.crawl.uid)).map((c) => [c.url, c.change]),
		[
			["https://a.test/w", "new"],
			["https://a.test/y", "changed"],
			["https://a.test/z", "removed"],
		],
	);
});

pgTest("listChanged reports everything as new with no baseline", async ({
	crawlerPg,
	run,
}) => {
	await fixture(run);
	const changed = await crawlerPg.listChanged(run.crawl.uid);

	// ok pages only — the 404 and the transport error are not "content".
	// Sorted here rather than trusting the server's collation for "/" vs "a".
	assertEquals(
		changed.map((c) => [c.url, c.change]).sort(),
		[
			[HOME, "new"],
			[NOT_MODIFIED, "new"],
			[PAGE_A, "new"],
		].sort(),
	);
	assertEquals(await crawlerPg.listChanged(crypto.randomUUID()), []);
});

// ---------------------------------------------------------------------------------
// stats, deletion, pruning
// ---------------------------------------------------------------------------------

pgTest("recomputeStats rebuilds the counters from the stored rows", async ({
	crawlerPg,
	run,
}) => {
	await fixture(run);
	await run.markRunning();

	const stats = await crawlerPg.recomputeStats(run.crawl.uid);

	assertEquals(stats.crawlId, run.crawl.uid);
	assertEquals(stats.queued, 1);
	assertEquals(stats.inFlight, 1);
	assertEquals(stats.done, 3);
	assertEquals(stats.failed, 2);
	assertEquals(stats.skipped, 1);
	assertEquals(stats.bytes, 115);
	// the transport error has no status, so it is in no histogram of statuses
	assertEquals(stats.byStatus, { 200: 2, 304: 1, 404: 1 });
	assertEquals(stats.skippedByReason, { "out-of-scope": 1 });
	assert(stats.elapsed >= 0);
	assert(stats.pagesPerSecond >= 0);
	assertEquals(stats.byHost, undefined);
	assertEquals(stats.eta, undefined);

	// and it force-writes what it computed
	assertEquals(await crawlerPg.crawlStats(run.crawl.uid), { ...stats });

	await assertRejects(
		() => crawlerPg.recomputeStats(crypto.randomUUID()),
		Error,
		"not found",
	);
}, { progressThrottleMs: 0 });

pgTest("deleteCrawl cascades the run and leaves the archive standing", async ({
	crawlerPg,
	run,
	db,
}) => {
	await fixture(run);
	const archived = await count(db, TABLE_URL);
	assert(archived > 0);

	assertEquals(await crawlerPg.deleteCrawl(run.crawl.uid), true);

	assertEquals(await count(db, TABLE_PAGE), 0);
	assertEquals(await count(db, TABLE_LINK), 0);
	assertEquals(await count(db, TABLE_FRONTIER), 0);
	assertEquals(await count(db, TABLE_URL), archived);
	assertEquals(await crawlerPg.getCrawl(run.crawl.uid), null);

	// a second delete is a no-op that says so
	assertEquals(await crawlerPg.deleteCrawl(run.crawl.uid), false);
});

pgTest("pruneUrls refuses to run without a filter", async ({ crawlerPg, run, db }) => {
	await fixture(run);
	const before = await count(db, TABLE_URL);

	await assertRejects(
		() => crawlerPg.pruneUrls({}),
		TypeError,
		"at least one filter",
	);
	await assertRejects(
		() => crawlerPg.pruneUrls({ host: "" }),
		TypeError,
		"at least one filter",
	);
	assertEquals(await count(db, TABLE_URL), before);
});

pgTest("pruneUrls deletes exactly the host it names", async ({ crawlerPg, run, db }) => {
	// userinfo and a port are the two ways a host hides inside a stored URL
	const withCredentials = "https://user:s3cret@b.test/private";
	const withPort = "https://b.test:8443/api";
	for (const url of [HOME, PAGE_A, withCredentials, withPort]) {
		await run.persistPage(
			page({ url, contentHash: `h-${url}` }),
			{ fetchResult: makeResult({ url, body: "x" }) },
		);
	}

	assertEquals(await crawlerPg.pruneUrls({ host: "b.test" }), 2);
	assertEquals(
		(await db.query(`SELECT url FROM ${TABLE_URL} ORDER BY url`)).rows.map((r) =>
			r.url
		),
		[HOME, PAGE_A],
	);
	// the page rows survive their archive row, with the reference cleared
	assertEquals(await count(db, TABLE_PAGE), 4);
	assertEquals(await count(db, TABLE_PAGE, "url_id IS NULL"), 2);
});

pgTest("pruneUrls deletes by age, and both filters together", async ({
	crawlerPg,
	run,
	db,
}) => {
	for (const url of [HOME, PAGE_A, "https://b.test/old"]) {
		await run.persistPage(
			page({ url, contentHash: `h-${url}` }),
			{ fetchResult: makeResult({ url, body: "x" }) },
		);
	}
	await db.query(
		`UPDATE ${TABLE_URL} SET fetched_at = NOW() - INTERVAL '30 days' WHERE url <> $1`,
		[HOME],
	);

	const cutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000);
	// host and olderThan are ANDed: only the old b.test row goes
	assertEquals(await crawlerPg.pruneUrls({ olderThan: cutoff, host: "b.test" }), 1);
	assertEquals(await count(db, TABLE_URL), 2);

	// epoch ms is accepted just as a Date is
	assertEquals(await crawlerPg.pruneUrls({ olderThan: cutoff.getTime() }), 1);
	assertEquals(
		(await db.query(`SELECT url FROM ${TABLE_URL}`)).rows.map((r) => r.url),
		[HOME],
	);
});

pgTest("pruneUrls only ever touches its own tenant", async ({ run, db }) => {
	await fixture(run);
	const mine = await count(db, TABLE_URL);

	const otherTenant = createCrawlerPg({
		db,
		tablePrefix: TEST_PREFIX,
		tenantId: "other",
	});
	const otherRun = await otherTenant.createCrawl({ seeds: [HOME] });
	await otherRun.persistPage(
		page({ url: HOME, contentHash: "h-other" }),
		{ fetchResult: makeResult({ url: HOME, body: "other" }) },
	);

	assertEquals(await otherTenant.pruneUrls({ host: "a.test" }), 1);
	assertEquals(await count(db, TABLE_URL), mine);
});
