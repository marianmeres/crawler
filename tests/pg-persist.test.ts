/**
 * `persistPage` against a live server: the body-keep/replace matrix of the URL archive,
 * the per-run page row, the link replace and the frontier ack.
 *
 * The body matrix is the reason this suite is long. `__crawler_url.body` is written by an
 * upsert whose every path — bytes in hand, 304, non-ok, `persistBody` off — is a way to
 * get the wrong bytes into an archive nobody re-reads until an incremental re-crawl
 * months later. The row has a second writer too (`PgVisitedStore.add`, which updates
 * `content_hash` outside the transaction), so "the hash is unchanged" never proves "the
 * bytes are unchanged".
 *
 * Gated on `TEST_PG_DATABASE` only: with the variable set but the server unreachable
 * these tests fail rather than skip.
 *
 * @module
 */

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { createPg } from "./_pg.ts";
import { makeResult, recordingLogger } from "./_helpers.ts";
import {
	type CrawlerPg,
	type CrawlerPgOptions,
	type CrawlPersistence,
	createCrawlerPg,
} from "../src/pg/mod.ts";
import type { LinkRecord, PageResult } from "../src/mod.ts";

const hasPg = !!Deno.env.get("TEST_PG_DATABASE");

const TEST_PREFIX = "_test_persist_";
const TABLE_URL = `${TEST_PREFIX}__crawler_url`;
const TABLE_PAGE = `${TEST_PREFIX}__crawler_page`;
const TABLE_LINK = `${TEST_PREFIX}__crawler_link`;
const TABLE_FRONTIER = `${TEST_PREFIX}__crawler_frontier`;

const decoder = new TextDecoder();

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
		from: "https://a.test/",
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
			const run = await crawlerPg.createCrawl({ seeds: ["https://a.test/"] });
			await fn({ crawlerPg, run, db });
		} finally {
			await crawlerPg.uninstall().catch(() => {});
			await db.end();
		}
	});
}

async function one(
	db: ReturnType<typeof createPg>,
	sql: string,
	values: unknown[] = [],
	// deno-lint-ignore no-explicit-any -- a pg result row is untyped by construction
): Promise<any> {
	const { rows } = await db.query(sql, values);
	return rows[0];
}

const URL_A = "https://a.test/one";

// ---------------------------------------------------------------------------------
// the body matrix
// ---------------------------------------------------------------------------------

pgTest("a changed content hash replaces the archived body", async ({ run, db }) => {
	await run.persistPage(
		page({ url: URL_A, contentHash: "h1", contentType: "text/html" }),
		{ fetchResult: makeResult({ url: URL_A, body: "v1" }) },
	);
	assertEquals(
		decoder.decode((await one(db, `SELECT body FROM ${TABLE_URL}`)).body),
		"v1",
	);

	await run.persistPage(
		page({ url: URL_A, contentHash: "h2", contentType: "text/html" }),
		{ fetchResult: makeResult({ url: URL_A, body: "v2" }) },
	);

	const row = await one(db, `SELECT * FROM ${TABLE_URL}`);
	assertEquals(decoder.decode(row.body), "v2");
	assertEquals(row.content_hash, "h2");
	assertEquals((await one(db, `SELECT count(*)::int AS c FROM ${TABLE_URL}`)).c, 1);
});

pgTest("a write that carries bytes replaces the stored ones, hash or no hash", async ({
	run,
	db,
}) => {
	await run.persistPage(
		page({ url: URL_A, contentHash: "h1" }),
		{ fetchResult: makeResult({ url: URL_A, body: "v1" }) },
	);
	const first = await one(db, `SELECT * FROM ${TABLE_URL}`);

	// Same hash, different bytes. This used to keep "v1" on the theory that an equal
	// hash proves equal bytes — but this row has a second writer. `PgVisitedStore.add`
	// stamps the *new* content_hash onto it from outside this transaction, so by the
	// time the upsert runs the hashes can match for a body that has in fact changed.
	// A write that has bytes in hand is the truth; only a write without any defers.
	await run.persistPage(
		page({ url: URL_A, contentHash: "h1" }),
		{ fetchResult: makeResult({ url: URL_A, body: "v1-but-different" }) },
	);

	const second = await one(db, `SELECT * FROM ${TABLE_URL}`);
	assertEquals(decoder.decode(second.body), "v1-but-different");
	assert(second.fetched_at > first.fetched_at, "fetched_at must be touched");
});

pgTest(
	"the visited store cannot strand a stale body under the current hash",
	async ({ run, db }) => {
		// the regression: `visited.add` wins the race against `persistPage`, so the row
		// already carries the new hash when the upsert that has the new bytes arrives
		await run.persistPage(
			page({ url: URL_A, contentHash: "old", contentType: "text/html" }),
			{ fetchResult: makeResult({ url: URL_A, body: "old-bytes" }) },
		);

		await run.stores.visited.add(URL_A, { contentHash: "new", status: 200 });
		assertEquals(
			(await one(db, `SELECT content_hash FROM ${TABLE_URL}`)).content_hash,
			"new",
		);

		await run.persistPage(
			page({ url: URL_A, contentHash: "new", contentType: "text/html" }),
			{ fetchResult: makeResult({ url: URL_A, body: "new-bytes" }) },
		);

		const row = await one(db, `SELECT * FROM ${TABLE_URL}`);
		assertEquals(decoder.decode(row.body), "new-bytes");
		assertEquals(row.content_hash, "new");
	},
);

pgTest("a 304 keeps the body and the validators, and records the status", async ({
	run,
	db,
}) => {
	await run.persistPage(
		page({
			url: URL_A,
			contentHash: "h1",
			contentType: "text/html",
			charset: "utf-8",
			size: 2,
		}),
		{
			fetchResult: makeResult({
				url: URL_A,
				body: "v1",
				headers: {
					etag: `"abc"`,
					"last-modified": "Wed, 21 Oct 2015 07:28:00 GMT",
				},
			}),
		},
	);

	// everything a 304 does not carry is undefined — that is the whole point of the test
	await run.persistPage(
		page({ url: URL_A, status: 304, ok: true, notModified: true }),
		{ fetchResult: makeResult({ url: URL_A, status: 304, hasBody: false }) },
	);

	const row = await one(db, `SELECT * FROM ${TABLE_URL}`);
	assertEquals(decoder.decode(row.body), "v1");
	assertEquals(row.content_hash, "h1");
	assertEquals(row.etag, `"abc"`);
	assertEquals(row.last_modified, "Wed, 21 Oct 2015 07:28:00 GMT");
	assertEquals(row.content_type, "text/html");
	assertEquals(row.charset, "utf-8");
	assertEquals(row.size, 2);
	assertEquals(row.last_status, 304);

	const pageRow = await one(db, `SELECT * FROM ${TABLE_PAGE}`);
	assertEquals(pageRow.status, 304);
	assertEquals(pageRow.ok, true);
	assertEquals(pageRow.not_modified, true);
});

pgTest("a non-ok response keeps the last good body and updates last_status", async ({
	run,
	db,
}) => {
	await run.persistPage(
		page({ url: URL_A, contentHash: "h1" }),
		{ fetchResult: makeResult({ url: URL_A, body: "v1" }) },
	);

	await run.persistPage(
		page({ url: URL_A, status: 500, ok: false, contentHash: "h-error" }),
		{ fetchResult: makeResult({ url: URL_A, status: 500, body: "server error" }) },
	);

	const row = await one(db, `SELECT * FROM ${TABLE_URL}`);
	assertEquals(decoder.decode(row.body), "v1");
	assertEquals(row.last_status, 500);
	// the hash still moves: it describes the last thing observed, the body does not
	assertEquals(row.content_hash, "h-error");
});

pgTest("persistBody: false archives the validators and no bytes", async ({ run, db }) => {
	await run.persistPage(
		page({ url: URL_A, contentHash: "h1" }),
		{
			fetchResult: makeResult({
				url: URL_A,
				body: "v1",
				headers: { etag: `"abc"` },
			}),
		},
	);

	const row = await one(db, `SELECT * FROM ${TABLE_URL}`);
	assertEquals(row.body, null);
	assertEquals(row.etag, `"abc"`);
	assertEquals(row.content_hash, "h1");
}, { persistBody: false });

pgTest("a persistBody predicate decides per page", async ({ run, db }) => {
	const html = "https://a.test/page.html";
	const pdf = "https://a.test/doc.pdf";

	await run.persistPage(
		page({ url: html, contentType: "text/html", contentHash: "h1" }),
		{ fetchResult: makeResult({ url: html, body: "<html>" }) },
	);
	await run.persistPage(
		page({ url: pdf, contentType: "application/pdf", contentHash: "h2" }),
		{ fetchResult: makeResult({ url: pdf, body: "%PDF" }) },
	);

	assertEquals(
		decoder.decode(
			(await one(db, `SELECT body FROM ${TABLE_URL} WHERE url = $1`, [html])).body,
		),
		"<html>",
	);
	assertEquals(
		(await one(db, `SELECT body FROM ${TABLE_URL} WHERE url = $1`, [pdf])).body,
		null,
	);
}, { persistBody: (res) => res.contentType === "text/html" });

// ---------------------------------------------------------------------------------
// the page row, the edges and the ack
// ---------------------------------------------------------------------------------

pgTest("a completed page writes its row, its edges and its ack", async ({ run, db }) => {
	const { frontier } = run.stores;
	await frontier.push({
		url: URL_A,
		host: "a.test",
		depth: 0,
		priority: 0,
		seq: 0,
		discoveredVia: "seed",
	});
	await frontier.pop();

	await run.persistPage(
		page({
			url: URL_A,
			finalUrl: "https://a.test/one/",
			redirects: ["https://a.test/one"],
			contentType: "text/html",
			contentHash: "h1",
			title: "One",
			size: 2,
			depth: 1,
			referrer: "https://a.test/",
			discoveredVia: "link",
			attempts: 2,
			data: { words: 42 },
			links: [
				link("https://a.test/two"),
				link("https://b.test/x", {
					kind: "external",
					followed: false,
					skipReason: "out-of-scope",
					anchorText: "elsewhere",
					nofollow: true,
					rel: "page",
				}),
			],
		}),
		{ fetchResult: makeResult({ url: URL_A, body: "v1" }) },
	);

	const row = await one(db, `SELECT * FROM ${TABLE_PAGE}`);
	assertEquals(row.url, URL_A);
	assertEquals(row.final_url, "https://a.test/one/");
	assertEquals(row.depth, 1);
	assertEquals(row.discovered_via, "link");
	assertEquals(row.referrer, "https://a.test/");
	assertEquals(row.status, 200);
	assertEquals(row.ok, true);
	assertEquals(row.title, "One");
	assertEquals(row.attempts, 2);
	assertEquals(row.timing, { total: 10, fetch: 8, extract: 2 });
	assertEquals(row.data, { words: 42 });
	assertEquals(row.error_kind, null);
	// the archive ref points at the row written by the same transaction
	assertEquals(
		row.url_id,
		(await one(db, `SELECT id FROM ${TABLE_URL} WHERE url = $1`, [URL_A])).id,
	);

	const { rows: links } = await db.query(
		`SELECT * FROM ${TABLE_LINK} ORDER BY to_url`,
	);
	assertEquals(links.length, 2);
	assertEquals(links[0].from_url, URL_A);
	assertEquals(links[0].to_url, "https://a.test/two");
	assertEquals(links[0].kind, "internal");
	assertEquals(links[0].followed, true);
	assertEquals(links[0].skip_reason, null);
	assertEquals(links[1].to_url, "https://b.test/x");
	assertEquals(links[1].kind, "external");
	assertEquals(links[1].nofollow, true);
	assertEquals(links[1].anchor_text, "elsewhere");
	assertEquals(links[1].followed, false);
	assertEquals(links[1].skip_reason, "out-of-scope");

	assertEquals(
		(await one(db, `SELECT status FROM ${TABLE_FRONTIER} WHERE url = $1`, [URL_A]))
			.status,
		"done",
	);
});

pgTest("replaying the same result leaves one page row and one set of edges", async ({
	run,
	db,
}) => {
	const res = page({
		url: URL_A,
		contentHash: "h1",
		links: [link("https://a.test/two"), link("https://a.test/three")],
	});
	const fetchResult = makeResult({ url: URL_A, body: "v1" });

	await run.persistPage(res, { fetchResult });
	const first = await one(db, `SELECT * FROM ${TABLE_PAGE}`);
	const { rows: firstLinks } = await db.query(
		`SELECT * FROM ${TABLE_LINK} ORDER BY to_url`,
	);

	await run.persistPage(res, { fetchResult });

	assertEquals((await one(db, `SELECT count(*)::int AS c FROM ${TABLE_PAGE}`)).c, 1);
	assertEquals((await one(db, `SELECT count(*)::int AS c FROM ${TABLE_URL}`)).c, 1);
	const second = await one(db, `SELECT * FROM ${TABLE_PAGE}`);
	assertEquals(second.id, first.id);
	assertEquals({ ...second, fetched_at: null }, { ...first, fetched_at: null });

	const { rows: secondLinks } = await db.query(
		`SELECT * FROM ${TABLE_LINK} ORDER BY to_url`,
	);
	assertEquals(secondLinks.length, 2);
	assertEquals(
		secondLinks.map((l) => l.to_url),
		firstLinks.map((l) => l.to_url),
	);
	// replaced, not merged: the rows are new ones
	assertNotEquals(secondLinks[0].id, firstLinks[0].id);
});

pgTest("re-persisting a page replaces its edges rather than adding to them", async ({
	run,
	db,
}) => {
	const other = "https://a.test/other";
	await run.persistPage(
		page({ url: other, contentHash: "h0", links: [link("https://a.test/two")] }),
		{ fetchResult: makeResult({ url: other, body: "v0" }) },
	);
	await run.persistPage(
		page({
			url: URL_A,
			contentHash: "h1",
			links: [link("https://a.test/one-a"), link("https://a.test/one-b")],
		}),
		{ fetchResult: makeResult({ url: URL_A, body: "v1" }) },
	);
	await run.persistPage(
		page({ url: URL_A, contentHash: "h2", links: [link("https://a.test/one-c")] }),
		{ fetchResult: makeResult({ url: URL_A, body: "v2" }) },
	);

	const { rows } = await db.query(`SELECT * FROM ${TABLE_LINK} ORDER BY to_url`);
	assertEquals(rows.map((l) => [l.from_url, l.to_url]), [
		[URL_A, "https://a.test/one-c"],
		// another page's edges are untouched by the replace
		[other, "https://a.test/two"],
	]);
});

pgTest("a transport error writes the page and leaves the archive alone", async ({
	run,
	db,
}) => {
	await run.persistPage(
		page({
			url: URL_A,
			status: 0,
			ok: false,
			attempts: 3,
			error: { kind: "timeout", message: "took too long", retryable: true },
		}),
	);

	assertEquals((await one(db, `SELECT count(*)::int AS c FROM ${TABLE_URL}`)).c, 0);
	const row = await one(db, `SELECT * FROM ${TABLE_PAGE}`);
	assertEquals(row.status, null);
	assertEquals(row.ok, false);
	assertEquals(row.url_id, null);
	assertEquals(row.error_kind, "timeout");
	assertEquals(row.error_message, "took too long");
	assertEquals(row.attempts, 3);
});

pgTest("a non-serializable onPage return lands as NULL, with one masked warning", async ({
	db,
}) => {
	const logger = recordingLogger();
	const withLogger = createCrawlerPg({
		db,
		tablePrefix: TEST_PREFIX,
		logger,
		tenantId: "logged",
	});
	const run = await withLogger.createCrawl({ seeds: ["https://a.test/"] });
	const url = "https://user:s3cret@a.test/data";

	await run.persistPage(
		page({ url, contentHash: "h1", data: { big: 10n } }),
		{ fetchResult: makeResult({ url, body: "v1" }) },
	);

	const row = await one(
		db,
		`SELECT * FROM ${TABLE_PAGE} WHERE crawl_id = $1`,
		[run.crawl.id],
	);
	assertEquals(row.data, null);
	// the write still happened, credentials and all — masking is a logging concern
	assertEquals(row.url, url);
	assertEquals(row.ok, true);

	const warnings = logger.messages("warn");
	assertEquals(warnings.length, 1);
	assert(warnings[0].includes("https://user:***@a.test/data"), warnings[0]);
	assert(!warnings[0].includes("s3cret"), warnings[0]);
});
