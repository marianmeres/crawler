import {
	assertEquals,
	assertMatch,
	assertNotEquals,
	assertRejects,
	assertThrows,
} from "@std/assert";
import { crawl, createCrawler } from "../src/crawler.ts";
import type { Crawler } from "../src/types.ts";

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

Deno.test("createCrawler() — the engine-backed members throw until the engine lands", () => {
	const crawler = createCrawler();

	const members: [string, () => unknown][] = [
		["Crawler.add()", () => crawler.add("https://example.com")],
		["Crawler.run()", () => crawler.run("https://example.com")],
		["Crawler.stop()", () => crawler.stop()],
		["Crawler.abort()", () => crawler.abort()],
		["Crawler.stats()", () => crawler.stats()],
		["Crawler.report()", () => crawler.report()],
	];

	for (const [name, call] of members) {
		assertThrows(call, Error, `${name} is not implemented yet`);
	}
});

Deno.test("crawl() — rejects (rather than hangs) while the engine is missing", async () => {
	await assertRejects(
		() => crawl("https://example.com"),
		Error,
		"Crawler.run() is not implemented yet",
	);
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
