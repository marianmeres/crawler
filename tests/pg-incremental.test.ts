/**
 * Incremental re-crawl end to end: run one archives bodies and validators, run two gets
 * `304`s back and has to keep crawling anyway.
 *
 * That last part is the whole point of the suite. A `304` arrives with no body, so
 * without the store-backed re-extraction a re-crawl finds no links, follows nothing and
 * "completes" after the seed — silently, and looking exactly like a site that shrank to
 * one page. The fixture graph is therefore two hops deep behind a `304`: reaching
 * `/deep` proves the links came out of the archive.
 *
 * The transport is a local conditional fake rather than `_helpers.ts`'s `siteFetch` —
 * answering `If-None-Match` is what is being tested, and it is not something the shared
 * fixture site knows how to do.
 *
 * Gated on `TEST_PG_DATABASE` only: with the variable set but the server unreachable
 * these tests fail rather than skip.
 *
 * @module
 */

import { assert, assertEquals, assertFalse } from "@std/assert";
import { createPg } from "./_pg.ts";
import { makeResult } from "./_helpers.ts";
import { crawl } from "../src/crawler.ts";
import {
	type CrawlerPg,
	type CrawlerPgOptions,
	type CrawlPersistence,
	createCrawlerPg,
} from "../src/pg/mod.ts";
import type { CrawlOptions, CrawlReport } from "../src/types.ts";
import type { FetchFn, FetchRequest, FetchResult } from "@marianmeres/page-fetcher";

const hasPg = !!Deno.env.get("TEST_PG_DATABASE");

const TEST_PREFIX = "_test_incr_";

const SITE = "http://inc.test";
const HOME = `${SITE}/`;
const PAGE_A = `${SITE}/a`;
const PAGE_B = `${SITE}/b`;
const DEEP = `${SITE}/deep`;

const LAST_MODIFIED = "Wed, 21 Oct 2015 07:28:00 GMT";

// -----------------------------------------------------------------------------------
// the conditional fake transport
// -----------------------------------------------------------------------------------

interface IncPage {
	html: string;
	etag: string;
	lastModified?: string;
	contentType?: string;
	/** A ready-made result, for the one fixture that needs raw non-UTF-8 bytes. */
	result?: (req: FetchRequest) => FetchResult;
}

type IncSite = Record<string, IncPage>;

type RecordingFetch = FetchFn & { calls: FetchRequest[] };

function headerOf(headers: Record<string, string> | undefined, name: string): string {
	const hit = Object.entries(headers ?? {}).find(
		([key]) => key.toLowerCase() === name,
	);
	return hit?.[1] ?? "";
}

/**
 * `siteFetch`, plus the one behavior this suite is about: a request whose
 * `If-None-Match` matches the page's current ETag is answered `304` with no body.
 *
 * `site` is read on every call, so a test can change a page between two runs.
 */
function conditionalFetch(site: IncSite): RecordingFetch {
	const calls: FetchRequest[] = [];

	const fetch: FetchFn = (req) => {
		calls.push(req);
		const page = site[req.url];

		if (page === undefined) {
			return Promise.resolve(
				makeResult({ url: req.url, status: 404, body: "not found" }),
			);
		}
		if (headerOf(req.headers, "if-none-match") === page.etag) {
			return Promise.resolve(makeResult({
				url: req.url,
				status: 304,
				hasBody: false,
				headers: { etag: page.etag },
			}));
		}
		if (page.result !== undefined) return Promise.resolve(page.result(req));

		const contentType = page.contentType ?? "text/html";
		return Promise.resolve(makeResult({
			url: req.url,
			body: page.html,
			contentType,
			charset: "utf-8",
			headers: {
				"content-type": `${contentType}; charset=utf-8`,
				etag: page.etag,
				...(page.lastModified === undefined
					? {}
					: { "last-modified": page.lastModified }),
			},
		}));
	};

	return Object.assign(fetch, { calls });
}

/** The requests this fetch made for `url` — one per run, in order. */
function callsFor(fetch: RecordingFetch, url: string): FetchRequest[] {
	return fetch.calls.filter((call) => call.url === url);
}

// -----------------------------------------------------------------------------------
// fixtures
// -----------------------------------------------------------------------------------

/**
 * Four pages, and only `/` is a seed: `/deep` hangs two link hops off it, so a run that
 * cannot read a `304`'s links stops at one page instead of four.
 */
function smallGraph(): IncSite {
	return {
		[HOME]: {
			etag: `"home-1"`,
			lastModified: LAST_MODIFIED,
			html: `<title>Home</title><a href="/a">A</a><a href="/b">B</a>`,
		},
		[PAGE_A]: {
			etag: `"a-1"`,
			lastModified: LAST_MODIFIED,
			html: `<title>A</title><a href="/b">B</a>`,
		},
		[PAGE_B]: {
			etag: `"b-1"`,
			lastModified: LAST_MODIFIED,
			html: `<title>B</title><a href="/deep">Deep</a>`,
		},
		[DEEP]: {
			etag: `"deep-1"`,
			lastModified: LAST_MODIFIED,
			html: `<title>Deep</title>`,
		},
	};
}

/** One reset schema, one pool — torn down whatever the body does. */
function pgTest(
	name: string,
	fn: (ctx: {
		crawlerPg: CrawlerPg;
		db: ReturnType<typeof createPg>;
	}) => Promise<void>,
	options: Omit<CrawlerPgOptions, "db" | "tablePrefix"> = {},
): void {
	Deno.test({ name: `pg: ${name}`, ignore: !hasPg }, async () => {
		const db = createPg();
		const crawlerPg = createCrawlerPg({ db, tablePrefix: TEST_PREFIX, ...options });
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
 * One full crawl into one crawl row: PG stores, `persistPage` on every page, lifecycle
 * marked like a real consumer's.
 *
 * `onPageDone` is an *event*, so the engine does not await it — the writes it starts are
 * collected here and awaited before the report is handed back, which is what makes the
 * assertions that follow deterministic.
 */
async function runCrawl(
	run: CrawlPersistence,
	fetch: FetchFn,
	options: CrawlOptions = {},
): Promise<CrawlReport> {
	const written: Promise<void>[] = [];
	await run.markRunning();

	const report = await crawl(HOME, {
		fetcher: fetch,
		stores: run.stores,
		recrawl: true,
		robots: { respect: false },
		concurrency: 1,
		...options,
		events: {
			onPageDone: (res, ctx) => {
				written.push(run.persistPage(res, ctx));
			},
		},
	});

	await Promise.all(written);
	await run.markEnded({ status: "completed", stats: report.stats });
	return report;
}

// -----------------------------------------------------------------------------------

pgTest(
	"a re-crawl of an unchanged site 304s every page and still traverses it",
	async ({ crawlerPg }) => {
		const site = smallGraph();
		const first = conditionalFetch(site);
		const run1 = await crawlerPg.createCrawl({ seeds: [HOME] });
		const report1 = await runCrawl(run1, first);

		assertEquals(report1.pages.length, 4);
		// nothing to be conditional about yet
		assertEquals(callsFor(first, HOME)[0].headers, undefined);

		// the archive now answers for every URL, bodies included
		const validators = await run1.getValidators(HOME);
		assertEquals(validators, {
			etag: `"home-1"`,
			lastModified: LAST_MODIFIED,
			contentHash: report1.pages.find((p) => p.url === HOME)!.contentHash,
			hasBody: true,
		});

		// --- the re-crawl -------------------------------------------------------------
		const second = conditionalFetch(site);
		const run2 = await crawlerPg.createCrawl({ seeds: [HOME] });
		const report2 = await runCrawl(run2, second);

		// both validators, on every request
		for (const url of [HOME, PAGE_A, PAGE_B, DEEP]) {
			const [call] = callsFor(second, url);
			assertEquals(headerOf(call.headers, "if-none-match"), site[url].etag);
			assertEquals(headerOf(call.headers, "if-modified-since"), LAST_MODIFIED);
		}

		// every page unchanged — and the whole graph still walked, two hops behind a 304
		assertEquals(report2.pages.length, 4);
		assertEquals(
			report2.pages.map((p) => p.url).sort(),
			[HOME, PAGE_A, PAGE_B, DEEP].sort(),
		);
		for (const page of report2.pages) {
			assert(page.notModified, `${page.url} should be notModified`);
			assert(page.ok, `${page.url} should be ok`);
			assertEquals(page.status, 304);
			// carried over from the archive: a 304 has no bytes to hash
			assertEquals(
				page.contentHash,
				report1.pages.find((p) => p.url === page.url)!.contentHash,
			);
		}

		const rows = await crawlerPg.listPages(run2.crawl.uid);
		assertEquals(rows.length, 4);
		for (const row of rows) {
			assert(row.notModified);
			assert(row.ok);
			assertEquals(row.status, 304);
		}

		// the edges are this run's own, re-extracted under this run's options
		const links = await crawlerPg.listLinks(run2.crawl.uid);
		assertEquals(
			links.map((l) => `${l.fromUrl} -> ${l.toUrl}`).sort(),
			[
				`${HOME} -> ${PAGE_A}`,
				`${HOME} -> ${PAGE_B}`,
				`${PAGE_A} -> ${PAGE_B}`,
				`${PAGE_B} -> ${DEEP}`,
			].sort(),
		);

		// unchanged means unchanged: no diff, and the archived bytes were never rewritten
		assertEquals(
			await crawlerPg.listChanged(run2.crawl.uid, { against: run1.crawl.uid }),
			[],
		);
		const stored = await run2.getStoredBody(HOME);
		assertEquals(new TextDecoder().decode(stored!.body), site[HOME].html);

		// and the next run can still be conditional — a 304 must not erase the validators
		assertEquals(await run2.getValidators(HOME), validators);
	},
);

pgTest(
	"a URL with validators but no stored body is fetched unconditionally",
	async ({ crawlerPg }) => {
		const site = smallGraph();
		const first = conditionalFetch(site);
		const run1 = await crawlerPg.createCrawl({ seeds: [HOME] });
		await runCrawl(run1, first);

		// the hash is archived either way — it is `hasBody` that decides, and only it
		const validatorsA = await run1.getValidators(PAGE_A);
		assertEquals(validatorsA!.etag, `"a-1"`);
		assertEquals(validatorsA!.lastModified, LAST_MODIFIED);
		assertFalse(validatorsA!.hasBody);
		assertEquals(await run1.getStoredBody(PAGE_A), null);

		const second = conditionalFetch(site);
		const run2 = await crawlerPg.createCrawl({ seeds: [HOME] });
		const report2 = await runCrawl(run2, second);

		// `/a` has an ETag stored and is still asked for in full: a 304 would leave the
		// crawl with no body to re-extract from
		assertEquals(callsFor(second, PAGE_A)[0].headers, undefined);
		const pageA = report2.pages.find((p) => p.url === PAGE_A)!;
		assertFalse(pageA.notModified);
		assertEquals(pageA.status, 200);

		// while `/` kept its body and therefore its conditional request
		assertEquals(
			headerOf(callsFor(second, HOME)[0].headers, "if-none-match"),
			`"home-1"`,
		);
		assert(report2.pages.find((p) => p.url === HOME)!.notModified);
	},
	{ persistBody: (res) => res.url !== PAGE_A },
);

pgTest(
	"a changed body produces a new hash and a listChanged 'changed' row",
	async ({ crawlerPg }) => {
		const site = smallGraph();
		const run1 = await crawlerPg.createCrawl({ seeds: [HOME] });
		const report1 = await runCrawl(run1, conditionalFetch(site));

		site[PAGE_A] = {
			etag: `"a-2"`,
			lastModified: LAST_MODIFIED,
			html: `<title>A, rewritten</title><a href="/b">B</a>`,
		};

		const second = conditionalFetch(site);
		const run2 = await crawlerPg.createCrawl({ seeds: [HOME] });
		const report2 = await runCrawl(run2, second);

		// the request was conditional, the answer was not
		assertEquals(
			headerOf(callsFor(second, PAGE_A)[0].headers, "if-none-match"),
			`"a-1"`,
		);
		const before = report1.pages.find((p) => p.url === PAGE_A)!;
		const after = report2.pages.find((p) => p.url === PAGE_A)!;
		assertFalse(after.notModified);
		assertEquals(after.status, 200);
		assert(after.contentHash !== before.contentHash);

		assertEquals(
			await crawlerPg.listChanged(run2.crawl.uid, { against: run1.crawl.uid }),
			[
				{
					url: PAGE_A,
					change: "changed",
					contentHash: after.contentHash!,
					previousHash: before.contentHash!,
				},
			],
		);

		// the archive followed the change: new bytes, new validator
		const stored = await run2.getStoredBody(PAGE_A);
		assertEquals(new TextDecoder().decode(stored!.body), site[PAGE_A].html);
		assertEquals((await run2.getValidators(PAGE_A))!.etag, `"a-2"`);
	},
);

pgTest(
	"the stored body is re-extracted with its stored charset",
	async ({ crawlerPg }) => {
		// `é` is one byte (0xE9) in windows-1252 and two in UTF-8: decoding the archived
		// bytes with the wrong charset yields U+FFFD, which is what this pins
		const html = `<title>Café</title><a href="/deep">Café</a>`;
		const bytes = singleByteEncode(html);

		const site: IncSite = {
			[HOME]: {
				etag: `"cafe-1"`,
				html,
				result: (req) => ({
					...makeResult({
						url: req.url,
						status: 200,
						contentType: "text/html",
						charset: "windows-1252",
						headers: {
							"content-type": "text/html; charset=windows-1252",
							etag: `"cafe-1"`,
						},
					}),
					size: bytes.byteLength,
					bytes: () => Promise.resolve(bytes),
					text: () => Promise.resolve(html),
				}),
			},
			[DEEP]: { etag: `"deep-1"`, html: `<title>Deep</title>` },
		};

		const run1 = await crawlerPg.createCrawl({ seeds: [HOME] });
		await runCrawl(run1, conditionalFetch(site));

		const archived = await run1.getStoredBody(HOME);
		assertEquals(archived!.charset, "windows-1252");
		assertEquals(archived!.body, bytes);

		const run2 = await crawlerPg.createCrawl({ seeds: [HOME] });
		const report2 = await runCrawl(run2, conditionalFetch(site));

		assert(report2.pages.find((p) => p.url === HOME)!.notModified);
		const links = await crawlerPg.listLinks(run2.crawl.uid);
		assertEquals(links.map((l) => l.anchorText), ["Café"]);
	},
);

pgTest(
	"the archive answers null for a URL this tenant never fetched",
	async ({ crawlerPg }) => {
		const run = await crawlerPg.createCrawl({ seeds: [HOME] });
		assertEquals(await run.getValidators(HOME), null);
		assertEquals(await run.getStoredBody(HOME), null);
	},
);

/** Every code point of `s` is < 256, so this is its windows-1252 encoding. */
function singleByteEncode(s: string): Uint8Array {
	const out = new Uint8Array(s.length);
	for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
	return out;
}
