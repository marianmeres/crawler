import {
	assert,
	assertEquals,
	assertFalse,
	assertMatch,
	assertNotEquals,
	assertThrows,
} from "@std/assert";
import { crawl, createCrawler } from "../src/crawler.ts";
import { createMemoryFrontier } from "../src/stores/memory-frontier.ts";
import { createMemoryVisited } from "../src/stores/memory-visited.ts";
import type { Crawler, PageResult } from "../src/types.ts";
import type { MiniSite } from "./_helpers.ts";
import { SITE, siteFetch, SMALL_SITE } from "./_helpers.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Pages the default same-host crawl of `SMALL_SITE` reaches from `/`.
 *
 * `robots.respect: false` throughout this file: robots enforcement has its own suite,
 * and pinning the *engine's* behavior against a gate that is not the subject of the
 * test would make every assertion here depend on two things at once.
 */
const REACHABLE = [
	`${SITE}/`,
	`${SITE}/a`,
	`${SITE}/b`,
	`${SITE}/dup`,
	`${SITE}/redirect`,
	`${SITE}/private/secret`,
	`${SITE}/t/a/b/a/b/a/b`,
];

// -----------------------------------------------------------------------------------
// construction
// -----------------------------------------------------------------------------------

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

// -----------------------------------------------------------------------------------
// crawl() — the report
// -----------------------------------------------------------------------------------

Deno.test("crawl() — report shape over the fixture site", async () => {
	const fake = siteFetch(SMALL_SITE);
	const report = await crawl(`${SITE}/`, {
		fetcher: fake,
		robots: { respect: false },
	});

	assertMatch(report.crawlId, UUID_RE);
	assertEquals(report.stoppedBy, "completed");
	assertEquals(report.stoppedReason, undefined);
	assertEquals(report.pages.map((p) => p.url).sort(), [...REACHABLE].sort());

	// the no-network proof: exactly the reachable pages were requested, nothing else
	assertEquals(fake.calls.map((c) => c.url).sort(), [...REACHABLE].sort());

	assertEquals(report.stats.crawlId, report.crawlId);
	assertEquals(report.stats.done, REACHABLE.length);
	assertEquals(report.stats.failed, 0);
	assertEquals(report.stats.queued, 0);
	assertEquals(report.stats.inFlight, 0);
	assertEquals(report.stats.byStatus, { 200: REACHABLE.length });
	assertEquals(report.stats.byHost, { "site.test": REACHABLE.length });
	assert(report.stats.bytes > 0);

	// every recorded edge points back at a page we actually crawled
	assert(report.graph.length > 0);
	for (const edge of report.graph) assert(REACHABLE.includes(edge.from));

	// and the JSONB promise: the snapshot survives a round trip
	assertEquals(JSON.parse(JSON.stringify(report.stats)).done, REACHABLE.length);
});

Deno.test("crawl() — one page, in full", async () => {
	const report = await crawl(`${SITE}/dup`, {
		fetcher: siteFetch(SMALL_SITE),
		robots: { respect: false },
	});

	const page = report.pages[0];
	assertEquals(page.url, `${SITE}/dup`);
	assertEquals(page.finalUrl, `${SITE}/dup`);
	assertEquals(page.redirects, []);
	assertEquals(page.status, 200);
	assertEquals(page.ok, true);
	assertEquals(page.depth, 0);
	assertEquals(page.discoveredVia, "seed");
	assertEquals(page.referrer, undefined);
	assertEquals(page.title, "Dup");
	assertEquals(page.contentType, "text/html");
	assertEquals(page.attempts, 1);
	assertEquals(page.fromCache, false);
	assertEquals(page.notModified, false);
	assertEquals(page.error, undefined);
	assertEquals(page.crawlId, report.crawlId);
	assertMatch(page.requestId, UUID_RE);
	assertMatch(page.contentHash!, /^[0-9a-f]{64}$/);
	assert(page.size! > 0);
	assertEquals(page.timing.total, page.timing.fetch + page.timing.extract);

	// PageResult never carries the body — that is what `onPage`'s ctx is for
	assertFalse("body" in page);
});

Deno.test("crawl() — depth is distance from the seed, and BFS pops in order", async () => {
	const order: PageResult[] = [];
	const report = await crawl(`${SITE}/`, {
		fetcher: siteFetch(SMALL_SITE),
		robots: { respect: false },
		// one worker: the completion sequence is then exactly the pop sequence
		concurrency: 1,
		perHostConcurrency: 1,
		onPage: (res) => void order.push(res),
	});

	assertEquals(order.map((p) => p.url), REACHABLE);
	assertEquals(order.map((p) => p.depth), [0, 1, 1, 1, 1, 1, 1]);
	assertEquals(
		report.pages.filter((p) => p.depth === 1).every((p) => p.referrer === `${SITE}/`),
		true,
	);
	assertEquals(
		report.pages.filter((p) => p.depth === 1).every((p) =>
			p.discoveredVia === "link"
		),
		true,
	);
});

Deno.test("crawl() — normalization dedupes: /dup is fetched once, from two spellings", async () => {
	const fake = siteFetch(SMALL_SITE);
	const report = await crawl(`${SITE}/`, {
		fetcher: fake,
		robots: { respect: false },
	});

	assertEquals(fake.calls.filter((c) => c.url === `${SITE}/dup`).length, 1);
	// `/` linked it with a tracking param, `/b` linked it clean — one target, two edges
	const edges = report.graph.filter((e) => e.to === `${SITE}/dup`);
	assertEquals(edges.map((e) => [e.from, e.rawHref, e.followed]), [
		[`${SITE}/`, "/dup?utm_source=x", true],
		[`${SITE}/b`, "/dup", false],
	]);
	assertEquals(edges[1].skipReason, "duplicate");
	assertEquals(report.stats.skippedByReason.duplicate, 4);
});

Deno.test("crawl() — a redirect is an attribute of its item, never an item of its own", async () => {
	const visited = createMemoryVisited();
	const fake = siteFetch(SMALL_SITE);
	const report = await crawl(`${SITE}/redirect`, {
		fetcher: fake,
		robots: { respect: false },
		stores: { visited },
	});

	assertEquals(report.pages.length, 1);
	const page = report.pages[0];
	assertEquals(page.url, `${SITE}/redirect`);
	assertEquals(page.finalUrl, `${SITE}/target`);
	assertEquals(page.redirects, [`${SITE}/redirect`]);
	assertEquals(page.title, "Target");
	assertEquals(page.discoveredVia, "seed");

	// the destination was never claimed, but it IS marked visited, so another referrer
	// pointing at it will not re-fetch the same bytes
	assertEquals(fake.calls.map((c) => c.url), [`${SITE}/redirect`]);
	assertEquals(await visited.has(`${SITE}/target`), true);
	assertEquals((await visited.get(`${SITE}/target`))?.status, 200);
});

Deno.test("crawl() — a redirect target waiting in the frontier is skipped at claim time", async () => {
	// The pathology a TLS-terminating proxy in front of an origin that does not know it
	// produces: every `https:` page 301s to its `http:` twin, and the twin's document
	// then resolves its own relative links against `http:`. So a second spelling of the
	// entire site reaches the frontier *before* the redirects proving it is the same
	// site have landed — and the enqueue-time duplicate check, which ran when those
	// items were pushed, is never re-asked.
	const TWIN = "twin.test";
	const site: MiniSite = {
		[`https://${TWIN}/`]: {
			html: `<title>Home</title><a href="/a">A</a><a href="/b">B</a>`,
		},
		[`https://${TWIN}/a`]: { redirectTo: `http://${TWIN}/a/` },
		[`https://${TWIN}/b`]: { redirectTo: `http://${TWIN}/b/` },
		[`http://${TWIN}/a/`]: { html: `<title>A</title><a href="/b/">B</a>` },
		[`http://${TWIN}/b/`]: { html: `<title>B</title><a href="/a/">A</a>` },
	};
	const fake = siteFetch(site);
	// serial, so the interleaving under test is the only one available: /a completes —
	// pushing the http twin of /b — strictly before /b is claimed
	const report = await crawl(`https://${TWIN}/`, {
		fetcher: fake,
		robots: { respect: false },
		concurrency: 1,
	});

	// three fetches, not four: `http://twin.test/b` was pushed by /a's document and
	// became visited while it sat in the frontier
	assertEquals(fake.calls.map((c) => c.url), [
		`https://${TWIN}/`,
		`https://${TWIN}/a`,
		`https://${TWIN}/b`,
	]);
	assertEquals(report.pages.map((p) => p.finalUrl), [
		`https://${TWIN}/`,
		`http://${TWIN}/a/`,
		`http://${TWIN}/b/`,
	]);
	// one duplicate refused at enqueue (/b's link back to the http twin of /a, already
	// visited by then) and one at claim time (the http twin of /b)
	assertEquals(report.stats.skippedByReason.duplicate, 2);
});

Deno.test("crawl() — two urls whose redirects converge deliver one page, not two", async () => {
	// What the claim-time gate is structurally too early to catch: both items are
	// already in flight when the redirects reveal they are one document. Where a
	// redirect lands is only knowable after the fetch, so completion is the earliest
	// anything *can* know.
	const CONV = "converge.test";
	const site: MiniSite = {
		[`https://${CONV}/`]: {
			html: `<title>Home</title><a href="/a">A</a><a href="/b">B</a>`,
		},
		[`https://${CONV}/a`]: { redirectTo: `https://${CONV}/target` },
		// a beat behind, so /a is deterministically the one that gets to deliver
		[`https://${CONV}/b`]: { redirectTo: `https://${CONV}/target`, delayMs: 20 },
		[`https://${CONV}/target`]: { html: `<title>Target</title>` },
	};
	const visited = createMemoryVisited();
	const fake = siteFetch(site);
	const report = await crawl(`https://${CONV}/`, {
		fetcher: fake,
		robots: { respect: false },
		stores: { visited },
	});

	// both were fetched — nothing could have known sooner
	assertEquals(fake.calls.map((c) => c.url), [
		`https://${CONV}/`,
		`https://${CONV}/a`,
		`https://${CONV}/b`,
	]);
	// but the document is delivered once, under the url that reached it first
	assertEquals(report.pages.map((p) => p.url), [
		`https://${CONV}/`,
		`https://${CONV}/a`,
	]);
	assertEquals(report.pages[1].finalUrl, `https://${CONV}/target`);
	assertEquals(report.stats.done, 2);
	assertEquals(report.stats.skippedByReason.duplicate, 1);

	// /b is marked visited anyway, so no later referrer goes back for it
	assertEquals(await visited.has(`https://${CONV}/b`), true);

	// and its bytes still count against the budget: they crossed the wire whether or
	// not the page was delivered
	const delivered = report.pages.reduce((n, p) => n + (p.size ?? 0), 0);
	assertEquals(report.stats.bytes, delivered + report.pages[1].size!);
});

Deno.test("crawl() — an unknown URL is a completed 404, not a failure to crawl", async () => {
	const report = await crawl(`${SITE}/nope`, {
		fetcher: siteFetch(SMALL_SITE),
		robots: { respect: false },
	});

	assertEquals(report.stoppedBy, "completed");
	assertEquals(report.pages.length, 1);
	assertEquals(report.pages[0].status, 404);
	assertEquals(report.pages[0].ok, false);
	assertEquals(report.pages[0].error, undefined);
	assertEquals(report.stats.done, 0);
	assertEquals(report.stats.failed, 1);
});

Deno.test("crawl() — a terminal fetch error is a PageResult, never a re-queue", async () => {
	const fake = siteFetch({
		[`${SITE}/`]: { error: { kind: "network", message: "boom" } },
	});
	const report = await crawl(`${SITE}/`, { fetcher: fake, robots: { respect: false } });

	assertEquals(report.pages.length, 1);
	assertEquals(report.pages[0].status, 0);
	assertEquals(report.pages[0].ok, false);
	assertEquals(report.pages[0].error?.kind, "network");
	assertEquals(report.pages[0].error?.message, "boom");
	assertEquals(report.stats.failed, 1);
	// page-fetcher owns retries; the engine asked exactly once
	assertEquals(fake.calls.length, 1);
	// a terminal error still has no HTTP status, so it stays out of the histogram
	assertEquals(report.stats.byStatus, {});
});

// -----------------------------------------------------------------------------------
// createCrawler() — streaming
// -----------------------------------------------------------------------------------

Deno.test("run() — streams results and collects nothing by default", async () => {
	const crawler = createCrawler({
		fetcher: siteFetch(SMALL_SITE),
		robots: { respect: false },
	});

	const seen: string[] = [];
	for await (const page of crawler.run(`${SITE}/`)) seen.push(page.url);

	assertEquals(seen.sort(), [...REACHABLE].sort());
	const report = crawler.report()!;
	assertEquals(report.stoppedBy, "completed");
	assertEquals(report.pages, []);
	assertEquals(report.graph, []);
	assertEquals(report.stats.done, REACHABLE.length);
});

Deno.test("run() — breaking out of the loop stops the crawl", async () => {
	const fake = siteFetch(SMALL_SITE);
	const crawler = createCrawler({
		fetcher: fake,
		robots: { respect: false },
		concurrency: 1,
		perHostConcurrency: 1,
	});

	const seen: string[] = [];
	for await (const page of crawler.run(`${SITE}/`)) {
		seen.push(page.url);
		if (seen.length === 2) break;
	}

	assertEquals(seen, [`${SITE}/`, `${SITE}/a`]);
	const report = crawler.report()!;
	assertEquals(report.stoppedBy, "stop");
	assertEquals(report.stoppedReason, "consumer-break");
	// dispatching really stopped — the rest of the site was never requested
	assert(
		fake.calls.length < REACHABLE.length,
		`expected fewer than ${REACHABLE.length} calls, got ${fake.calls.length}`,
	);
});

Deno.test("run() — report() is undefined until the run ends", async () => {
	const crawler = createCrawler({
		fetcher: siteFetch(SMALL_SITE),
		robots: { respect: false },
	});

	assertEquals(crawler.report(), undefined);
	const iterator = crawler.run(`${SITE}/`);
	await iterator.next();
	assertEquals(crawler.report(), undefined);

	for await (const _page of iterator) { /* drain */ }
	assertNotEquals(crawler.report(), undefined);
});

Deno.test("run() — is single-use", async () => {
	const crawler = createCrawler({
		fetcher: siteFetch(SMALL_SITE),
		robots: { respect: false },
	});
	for await (const _page of crawler.run(`${SITE}/dup`)) { /* drain */ }

	assertThrows(() => crawler.run(`${SITE}/dup`), Error, "single-use");
});

Deno.test("run() — stats() is live during the crawl", async () => {
	const crawler = createCrawler({
		fetcher: siteFetch(SMALL_SITE),
		robots: { respect: false },
		concurrency: 1,
		perHostConcurrency: 1,
	});

	assertEquals(crawler.stats().done, 0);
	assertEquals(crawler.stats().queued, 0);

	let sawQueuedWork = false;
	for await (const _page of crawler.run(`${SITE}/`)) {
		if (crawler.stats().queued > 0) sawQueuedWork = true;
	}

	assert(sawQueuedWork, "stats().queued never reported the discovered frontier");
	assertEquals(crawler.stats().done, REACHABLE.length);
});

Deno.test("run() — a slow consumer backpressures the crawl", async () => {
	const fake = siteFetch(SMALL_SITE);
	const crawler = createCrawler({
		fetcher: fake,
		robots: { respect: false },
		concurrency: 2,
		perHostConcurrency: 2,
	});

	let taken = 0;
	for await (const _page of crawler.run(`${SITE}/`)) {
		taken++;
		// capacity is concurrency * 2, and at most `concurrency` workers can be parked
		// on top of that, so the crawl can never run more than this far ahead
		assert(
			fake.calls.length <= taken + 2 * 2 + 2,
			`crawl ran ${fake.calls.length - taken} pages ahead of the consumer`,
		);
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	assertEquals(taken, REACHABLE.length);
});

// -----------------------------------------------------------------------------------
// add()
// -----------------------------------------------------------------------------------

Deno.test("add() — queues manually, before and during a run, and echoes meta", async () => {
	const crawler = createCrawler({
		fetcher: siteFetch(SMALL_SITE),
		robots: { respect: false },
		collect: { pages: true },
	});

	crawler.add(`${SITE}/a`, { meta: { tag: "pre-run" } });

	const seen: PageResult[] = [];
	for await (const page of crawler.run()) {
		seen.push(page);
		if (page.url === `${SITE}/a`) crawler.add(`${SITE}/dup`, { depth: 7 });
	}

	assertEquals(seen[0].url, `${SITE}/a`);
	assertEquals(seen[0].discoveredVia, "manual");
	assertEquals(seen[0].meta, { tag: "pre-run" });
	assertEquals(seen[0].depth, 0);

	const dup = seen.find((p) => p.url === `${SITE}/dup`)!;
	assertEquals(dup.discoveredVia, "manual");
	assertEquals(dup.depth, 7);
});

Deno.test("add() — a bare host is given a scheme; junk is dropped, not thrown", async () => {
	const fake = siteFetch({ "https://site.test/": { html: `<title>secure</title>` } });
	const crawler = createCrawler({ fetcher: fake, robots: { respect: false } });

	crawler.add(["site.test", "mailto:a@b.com", "   ", "not a url"]);
	for await (const _page of crawler.run()) { /* drain */ }

	assertEquals(fake.calls.map((c) => c.url), ["https://site.test/"]);
});

// -----------------------------------------------------------------------------------
// hooks
// -----------------------------------------------------------------------------------

Deno.test("onPage() — its return lands on PageResult.data, with body access via ctx", async () => {
	const report = await crawl(`${SITE}/dup`, {
		fetcher: siteFetch(SMALL_SITE),
		robots: { respect: false },
		onPage: async (res, ctx) => {
			assertEquals(ctx.crawlId, res.crawlId);
			assertEquals(ctx.item.url, res.url);
			assertEquals(ctx.stats.crawlId, res.crawlId);
			return { length: (await ctx.fetchResult!.text()).length };
		},
	});

	assertEquals(report.pages[0].data, { length: `<title>Dup</title>`.length });
});

Deno.test("onPage() — a throwing hook fails its page and nothing else", async () => {
	const report = await crawl(`${SITE}/`, {
		fetcher: siteFetch(SMALL_SITE),
		robots: { respect: false },
		onPage: (res) => {
			if (res.url === `${SITE}/a`) throw new Error("hook exploded");
			return undefined;
		},
	});

	const failed = report.pages.find((p) => p.url === `${SITE}/a`)!;
	assertEquals(failed.ok, false);
	assertEquals(failed.status, 200);
	assertEquals(failed.error?.kind, "internal");
	assertEquals(failed.error?.message, "hook exploded");
	assertEquals(report.stats.failed, 1);
	assertEquals(report.stats.done, REACHABLE.length - 1);
});

Deno.test("shouldVisit() — returning false records skipReason 'user'", async () => {
	const fake = siteFetch(SMALL_SITE);
	const report = await crawl(`${SITE}/`, {
		fetcher: fake,
		robots: { respect: false },
		shouldVisit: (url, ctx) => {
			assertEquals(ctx.link.to, url);
			assertEquals(ctx.referrer, ctx.link.from);
			return !url.endsWith("/private/secret");
		},
	});

	assertFalse(fake.calls.some((c) => c.url === `${SITE}/private/secret`));
	const edge = report.graph.find((e) => e.to === `${SITE}/private/secret`)!;
	assertEquals(edge.followed, false);
	assertEquals(edge.skipReason, "user");
	assertEquals(report.stats.skippedByReason.user, 1);
});

Deno.test("onLink() — fires for every edge, followed or not", async () => {
	const seen: [string, boolean][] = [];
	const report = await crawl(`${SITE}/`, {
		fetcher: siteFetch(SMALL_SITE),
		robots: { respect: false },
		onLink: (link) => void seen.push([link.to, link.followed]),
	});

	assertEquals(seen.length, report.graph.length);
	assertEquals(
		seen.filter(([, followed]) => followed).length,
		report.graph.filter((e) => e.followed).length,
	);
});

// -----------------------------------------------------------------------------------
// budgets that prune (the ones that stop a run are backlog rank 16)
// -----------------------------------------------------------------------------------

Deno.test("maxDepth — prunes expansion and still completes normally", async () => {
	const fake = siteFetch(SMALL_SITE);
	const report = await crawl(`${SITE}/`, {
		fetcher: fake,
		robots: { respect: false },
		maxDepth: 0,
	});

	assertEquals(fake.calls.map((c) => c.url), [`${SITE}/`]);
	assertEquals(report.stoppedBy, "completed");
	// six on-site links on `/`, all pruned; the external one is out-of-scope first
	assertEquals(report.stats.skippedByReason["max-depth"], 6);
});

Deno.test("maxQueued — an overflowing link is skipped, never dropped silently", async () => {
	const report = await crawl(`${SITE}/`, {
		fetcher: siteFetch(SMALL_SITE),
		robots: { respect: false },
		maxQueued: 3,
	});

	const full = report.graph.filter((e) => e.skipReason === "queue-full");
	assert(full.length > 0, "expected at least one queue-full skip");
	assertEquals(report.stats.skippedByReason["queue-full"], full.length);
});

// -----------------------------------------------------------------------------------
// stop / abort / dispose
// -----------------------------------------------------------------------------------

Deno.test("stop() — drains what is in flight and still delivers it", async () => {
	const fake = siteFetch(SMALL_SITE);
	const crawler = createCrawler({
		fetcher: fake,
		robots: { respect: false },
		concurrency: 2,
		perHostConcurrency: 2,
	});

	const seen: string[] = [];
	for await (const page of crawler.run(`${SITE}/`)) {
		seen.push(page.url);
		// fire-and-forget: awaiting it here is the shape that used to deadlock
		if (seen.length === 1) void crawler.stop("enough");
	}

	const report = crawler.report()!;
	assertEquals(report.stoppedBy, "stop");
	assertEquals(report.stoppedReason, "enough");
	// everything that had been dispatched was delivered, and nothing more was
	assertEquals(seen.length, fake.calls.length);
	assert(seen.length < REACHABLE.length);
});

Deno.test("stop() — awaiting it from outside the loop resolves after finalization", async () => {
	const crawler = createCrawler({
		fetcher: siteFetch(SMALL_SITE),
		robots: { respect: false },
	});

	const iterator = crawler.run(`${SITE}/`);
	assertEquals((await iterator.next()).done, false);
	await crawler.stop("done here");

	assertEquals(crawler.report()?.stoppedBy, "stop");
	assertEquals(crawler.report()?.stoppedReason, "done here");

	// a graceful stop still hands over what was in flight when it landed — the
	// iterator drains those, and only then reports done
	let delivered = 1;
	for await (const _page of iterator) delivered++;
	assert(delivered >= 1 && delivered < REACHABLE.length, `delivered ${delivered}`);
	assertEquals((await iterator.next()).done, true);
});

Deno.test("abort() — releases the claims of in-flight items", async () => {
	const frontier = createMemoryFrontier();
	const crawler = createCrawler({
		fetcher: siteFetch({
			[`${SITE}/`]: { html: `<title>slow</title>`, delayMs: 500 },
		}),
		robots: { respect: false },
		stores: { frontier },
		concurrency: 1,
	});

	const timer = setTimeout(() => crawler.abort("cancelled"), 20);
	const seen: string[] = [];
	for await (const page of crawler.run(`${SITE}/`)) seen.push(page.url);
	clearTimeout(timer);

	// an aborted fetch produces no result at all — it is not a failed page
	assertEquals(seen, []);
	assertEquals(crawler.report()?.stoppedBy, "abort");
	assertEquals(crawler.report()?.stoppedReason, "cancelled");
	// and the claim went back to pending, so a resumable store can hand it out again
	assertEquals(await frontier.size(), 1);
});

Deno.test("signal — firing the external signal takes the abort path", async () => {
	const controller = new AbortController();
	const crawler = createCrawler({
		fetcher: siteFetch({
			[`${SITE}/`]: { html: `<title>slow</title>`, delayMs: 500 },
		}),
		robots: { respect: false },
		signal: controller.signal,
	});

	const timer = setTimeout(() => controller.abort(), 20);
	for await (const _page of crawler.run(`${SITE}/`)) { /* nothing arrives */ }
	clearTimeout(timer);

	assertEquals(crawler.report()?.stoppedBy, "abort");
	assertEquals(crawler.report()?.stoppedReason, "signal");
});

Deno.test("dispose — aborts a running crawl and finalizes it", async () => {
	const crawler = createCrawler({
		fetcher: siteFetch({
			[`${SITE}/`]: { html: `<title>slow</title>`, delayMs: 500 },
		}),
		robots: { respect: false },
	});

	const iterator = crawler.run(`${SITE}/`);
	const pending = iterator.next();
	await crawler[Symbol.asyncDispose]();

	assertEquals((await pending).done, true);
	assertEquals(crawler.report()?.stoppedBy, "abort");
});
