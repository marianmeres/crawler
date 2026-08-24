import { assertEquals, assertMatch, assertNotEquals, assertThrows } from "@std/assert";
import { crawl, createCrawler } from "../src/crawler.ts";
import type { Crawler } from "../src/types.ts";
import type { FetchFn, FetchResult } from "@marianmeres/page-fetcher";

/**
 * A one-page fake transport. The real fixture mini-site + `siteFetch` helper are the
 * next task ({@link file://./../docs/plan/PROGRESS.md} rank 13); this is only enough to
 * prove the engine runs end to end.
 */
function onePage(html: string): FetchFn {
	const bytes = new TextEncoder().encode(html);
	return (req) =>
		Promise.resolve(
			{
				ok: true,
				url: req.url,
				finalUrl: req.url,
				status: 200,
				headers: new Headers({ "content-type": "text/html" }),
				redirects: [],
				requestId: crypto.randomUUID(),
				hasBody: req.retainBody !== false,
				text: () => Promise.resolve(html),
				bytes: () => Promise.resolve(bytes),
				contentType: "text/html",
				size: bytes.byteLength,
				fromCache: false,
				notModified: false,
				timing: { startedAt: 0, endedAt: 0, total: 0 },
				attempts: 1,
				adapter: "fake",
				meta: req.meta,
			} satisfies FetchResult,
		);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

Deno.test("createCrawler() — mints a fresh crawlId per crawler", () => {
	const a = createCrawler();
	const b = createCrawler();

	assertMatch(a.crawlId, UUID_RE);
	assertMatch(b.crawlId, UUID_RE);
	assertNotEquals(a.crawlId, b.crawlId);

	// stable for the lifetime of the handle — it stamps every result and event
	assertEquals(a.crawlId, a.crawlId);
});

Deno.test("createCrawler() — validates options at construction, not at run()", () => {
	assertThrows(
		() => createCrawler({ concurrency: 0 }),
		TypeError,
		"options.concurrency",
	);
	assertThrows(
		() => createCrawler({ strategy: "priority" }),
		TypeError,
		"requires options.priority",
	);
});

Deno.test("createCrawler() — disposing a crawler that never ran is a no-op", async () => {
	const crawler = createCrawler();
	await crawler[Symbol.asyncDispose]();
});

Deno.test("crawl()/createCrawler() — the handle satisfies the Crawler contract", () => {
	// compile-time assertion first: the shell really is a full `Crawler`
	const crawler: Crawler = createCrawler();

	assertEquals(typeof crawler.crawlId, "string");
	for (
		const member of ["add", "run", "stop", "abort", "stats", "report"] as const
	) {
		assertEquals(typeof crawler[member], "function", `missing ${member}`);
	}
	assertEquals(typeof crawler[Symbol.asyncDispose], "function");
});

Deno.test("crawl() — runs the engine end to end over a fake transport", async () => {
	const report = await crawl("http://site.test/", {
		fetcher: onePage(`<title>Hi</title><a href="/a">a</a>`),
		maxDepth: 1,
	});

	assertEquals(report.stoppedBy, "completed");
	assertEquals(report.pages.map((p) => p.url), [
		"http://site.test/",
		"http://site.test/a",
	]);
	assertEquals(report.pages[0].title, "Hi");
	assertEquals(report.pages[0].depth, 0);
	assertEquals(report.pages[1].depth, 1);
	assertEquals(report.stats.done, 2);
});

Deno.test("createCrawler() — run() is single-use", async () => {
	const crawler = createCrawler({ fetcher: onePage(`<title>x</title>`) });
	for await (const _page of crawler.run("http://site.test/")) { /* drain */ }

	assertThrows(() => crawler.run("http://site.test/"), Error, "single-use");
});
