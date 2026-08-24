/**
 * Scope, region filtering and the `beforeExtract` two-pass split, over fake transports.
 *
 * The robots half this file is named for is backlog rank 14 — the gate does not exist
 * yet, so every crawl here is a crawl of URLs no robots.txt has an opinion about.
 */

import { assert, assertEquals, assertFalse } from "@std/assert";
import { crawl } from "../src/crawler.ts";
import { recordingLogger, SITE, siteFetch, SMALL_SITE } from "./_helpers.ts";
import type { MiniSite } from "./_helpers.ts";

// -----------------------------------------------------------------------------------
// host + path scope
// -----------------------------------------------------------------------------------

Deno.test("scope — same-host is the default: an external link is recorded, not visited", async () => {
	const fake = siteFetch(SMALL_SITE);
	const report = await crawl(`${SITE}/`, { fetcher: fake });

	const edge = report.graph.find((e) => e.to === "http://ext.test/x")!;
	assertEquals(edge.kind, "external");
	assertEquals(edge.followed, false);
	assertEquals(edge.skipReason, "out-of-scope");
	assertEquals(report.stats.skippedByReason["out-of-scope"], 1);
	assertFalse(fake.calls.some((c) => c.url.startsWith("http://ext.test")));
});

Deno.test("scope — allowExternal follows off-site links and expands them", async () => {
	const fake = siteFetch(SMALL_SITE);
	const report = await crawl(`${SITE}/`, {
		fetcher: fake,
		scope: { allowExternal: true },
		maxDepth: 1,
	});

	assert(fake.calls.some((c) => c.url === "http://ext.test/x"));
	const external = report.pages.find((p) => p.url === "http://ext.test/x")!;
	assertEquals(external.title, "External");
	// expanded: its own link was seen (and pruned by maxDepth, not by scope)
	assertEquals(external.links.map((l) => [l.to, l.skipReason]), [
		["http://ext.test/y", "max-depth"],
	]);
});

Deno.test("scope — checkExternal fetches an external once, body-less and unexpanded", async () => {
	const fake = siteFetch(SMALL_SITE);
	const report = await crawl(`${SITE}/`, {
		fetcher: fake,
		scope: { checkExternal: true },
	});

	const call = fake.calls.find((c) => c.url === "http://ext.test/x")!;
	assertEquals(call.retainBody, false);

	const external = report.pages.find((p) => p.url === "http://ext.test/x")!;
	assertEquals(external.status, 200);
	assertEquals(external.links, []);
	assertEquals(external.contentHash, undefined);
	assertEquals(external.size, undefined);
	// the link-check mode never leaves the site it was checking from
	assertFalse(fake.calls.some((c) => c.url === "http://ext.test/y"));
});

Deno.test("scope — a seed bypasses pathPrefix; the links it finds do not", async () => {
	const fake = siteFetch(SMALL_SITE);
	const report = await crawl(`${SITE}/`, {
		fetcher: fake,
		scope: { pathPrefix: "/a" },
	});

	// the seed is the instruction, not a discovery — narrowing it would make this
	// crawl fetch nothing at all
	assertEquals(fake.calls.map((c) => c.url), [
		`${SITE}/robots.txt`,
		`${SITE}/`,
		`${SITE}/a`,
	]);
	assertEquals(
		report.graph.filter((e) => e.skipReason === "out-of-scope").map((e) => e.to)
			.sort(),
		[
			// off `/`
			"http://ext.test/x",
			`${SITE}/b`,
			`${SITE}/dup`,
			`${SITE}/private/secret`,
			`${SITE}/redirect`,
			`${SITE}/t/a/b/a/b/a/b`,
			// off `/a` — the seed's own path is outside the prefix too, once it is
			// something a page linked to rather than the instruction
			`${SITE}/`,
			`${SITE}/b`,
		].sort(),
	);
});

Deno.test("scope — exclude wins, and an include miss reports 'excluded'", async () => {
	const excluded = await crawl(`${SITE}/`, {
		fetcher: siteFetch(SMALL_SITE),
		scope: { exclude: ["/private/"] },
		maxDepth: 1,
	});
	const secret = excluded.graph.find((e) => e.to === `${SITE}/private/secret`)!;
	assertEquals(secret.skipReason, "excluded");

	const included = await crawl(`${SITE}/`, {
		fetcher: siteFetch(SMALL_SITE),
		scope: { include: ["/dup"] },
		maxDepth: 1,
	});
	assertEquals(
		included.pages.map((p) => p.url).sort(),
		[`${SITE}/`, `${SITE}/dup`],
	);
	assertEquals(included.stats.skippedByReason.excluded, 5);
});

// -----------------------------------------------------------------------------------
// region scoping
// -----------------------------------------------------------------------------------

const REGION = "http://region.test";

const REGION_SITE: MiniSite = {
	[`${REGION}/`]: {
		html: `<!doctype html><html><head><title>Landmarks</title></head><body>
	<header><a href="/header">header</a></header>
	<nav><a href="/nav">nav</a></nav>
	<main>
		<a href="/main">main</a>
		<article><a href="/article">article</a></article>
		<nav><a href="/main-nav">nav inside main</a></nav>
	</main>
	<aside><a href="/aside">aside</a></aside>
	<footer><a href="/footer">footer</a></footer>
</body></html>`,
	},
	[`${REGION}/header`]: { html: `<title>header</title>` },
	[`${REGION}/nav`]: { html: `<title>nav</title>` },
	[`${REGION}/main`]: { html: `<title>main</title>` },
	[`${REGION}/article`]: { html: `<title>article</title>` },
	[`${REGION}/main-nav`]: { html: `<title>main-nav</title>` },
	[`${REGION}/aside`]: { html: `<title>aside</title>` },
	[`${REGION}/footer`]: { html: `<title>footer</title>` },
};

Deno.test("followRegions — content links are followed, chrome links are recorded and skipped", async () => {
	const fake = siteFetch(REGION_SITE);
	const report = await crawl(`${REGION}/`, {
		fetcher: fake,
		scope: { followRegions: ["main", "article"] },
	});

	assertEquals(fake.calls.map((c) => c.url), [
		`${REGION}/robots.txt`,
		`${REGION}/`,
		`${REGION}/main`,
		`${REGION}/article`,
	]);

	// nothing is missing from the graph — the chrome links are all there, with a reason
	const skipped = report.graph
		.filter((e) => e.skipReason === "out-of-region")
		.map((e) => [e.to, e.region]);
	assertEquals(skipped, [
		[`${REGION}/header`, "header"],
		[`${REGION}/nav`, "nav"],
		// innermost landmark wins: this one is inside <main>, but its nearest
		// landmark is the <nav> it sits in
		[`${REGION}/main-nav`, "nav"],
		[`${REGION}/aside`, "aside"],
		[`${REGION}/footer`, "footer"],
	]);
	assertEquals(report.stats.skippedByReason["out-of-region"], 5);
});

Deno.test("followRegions — ['main'] alone skips the <article> body (the documented footgun)", async () => {
	const fake = siteFetch(REGION_SITE);
	await crawl(`${REGION}/`, {
		fetcher: fake,
		scope: { followRegions: ["main"] },
	});

	assertEquals(fake.calls.map((c) => c.url), [
		`${REGION}/robots.txt`,
		`${REGION}/`,
		`${REGION}/main`,
	]);
});

Deno.test("followRegions — a landmark-free page still crawls, warning once per crawl", async () => {
	const PLAIN = "http://plain.test";
	const logger = recordingLogger();
	const fake = siteFetch({
		[`${PLAIN}/`]: { html: `<title>one</title><a href="/two">two</a>` },
		[`${PLAIN}/two`]: { html: `<title>two</title><a href="/three">three</a>` },
		[`${PLAIN}/three`]: { html: `<title>three</title>` },
	});

	await crawl(`${PLAIN}/`, {
		fetcher: fake,
		logger,
		scope: { followRegions: ["main", "article"] },
	});

	// the whole-document fallback: without it one non-semantic page dead-ends the crawl
	assertEquals(fake.calls.filter((c) => !c.url.endsWith("/robots.txt")).length, 3);
	const warnings = logger.messages("warn").filter((m) => m.includes("followRegions"));
	assertEquals(warnings.length, 1, warnings.join("\n"));
});

// -----------------------------------------------------------------------------------
// beforeExtract — the two-pass rule
// -----------------------------------------------------------------------------------

const SOUP = "http://soup.test";

/** `<div class="main">` markup: nothing for `followRegions` to match, which is the point. */
const SOUP_HTML = `<!doctype html><html><head>
<title>Div soup</title>
<base href="${SOUP}/base/">
<link rel="canonical" href="/canon">
<meta name="robots" content="noindex">
</head><body>
<div class="chrome"><a href="chrome">chrome</a></div>
<div class="main"><a href="content">content</a></div>
</body></html>`;

const SOUP_SITE: MiniSite = {
	[`${SOUP}/`]: { html: SOUP_HTML },
	[`${SOUP}/two`]: { html: SOUP_HTML },
	[`${SOUP}/base/chrome`]: { html: `<title>chrome</title>` },
	[`${SOUP}/base/content`]: { html: `<title>content</title>` },
	[`${SOUP}/canon`]: { html: `<title>canon</title>` },
};

/** The one-line recipe from the docs, without the html-extract dependency. */
function narrowToMain(html: string): string {
	const open = html.indexOf(`<div class="main">`);
	if (open < 0) return html;
	const close = html.indexOf("</div>", open);
	return html.slice(open, close < 0 ? undefined : close + "</div>".length);
}

Deno.test("beforeExtract — narrows body links while <head> data survives", async () => {
	const fake = siteFetch(SOUP_SITE);
	const report = await crawl(`${SOUP}/`, {
		fetcher: fake,
		beforeExtract: (html) => narrowToMain(html),
		maxDepth: 1,
	});

	const page = report.pages.find((p) => p.url === `${SOUP}/`)!;

	// pass one, over the RAW document: everything `<head>`-derived is intact
	assertEquals(page.title, "Div soup");
	assertEquals(page.canonical, `${SOUP}/canon`);
	assertEquals(page.robots, { noindex: true, nofollow: false });

	// pass two, over the NARROWED html: the chrome link is gone
	assertEquals(page.links.map((l) => l.to), [
		`${SOUP}/canon`,
		`${SOUP}/base/content`,
	]);
	assertFalse(fake.calls.some((c) => c.url.endsWith("/chrome")));
});

Deno.test("beforeExtract — a relative link still resolves against the raw <base href>", async () => {
	// The regression this test exists for: `<base>` lives in `<head>`, so it is gone
	// from the narrowed HTML. If the body pass were left to find its own base it would
	// resolve against finalUrl and every relative link on a `<base>`-bearing page would
	// silently point at the wrong place.
	const fake = siteFetch(SOUP_SITE);
	await crawl(`${SOUP}/`, {
		fetcher: fake,
		beforeExtract: (html) => narrowToMain(html),
		maxDepth: 1,
	});

	assert(
		fake.calls.some((c) => c.url === `${SOUP}/base/content`),
		`resolved against finalUrl instead of <base>: ${
			fake.calls.map((c) => c.url).join(", ")
		}`,
	);
});

Deno.test("beforeExtract — hashes and sizes stay those of the raw body", async () => {
	const report = await crawl(`${SOUP}/`, {
		fetcher: siteFetch(SOUP_SITE),
		beforeExtract: (html) => narrowToMain(html),
		maxDepth: 0,
	});

	const raw = new TextEncoder().encode(SOUP_HTML);
	const page = report.pages[0];
	assertEquals(page.size, raw.byteLength);
	assertEquals(page.contentHash, await sha256Hex(raw));
});

Deno.test("beforeExtract — a throwing hook falls back to the full document, warning once", async () => {
	const logger = recordingLogger();
	const fake = siteFetch(SOUP_SITE);
	const report = await crawl(`${SOUP}/`, {
		fetcher: fake,
		logger,
		beforeExtract: () => {
			throw new Error("narrowing exploded");
		},
		// two pages so "once per crawl" means something
		maxDepth: 1,
		scope: { include: ["/", "/two"] },
	});
	report.crawlId; // (silences the unused-binding lint without weakening the test)

	// the page did NOT fail, and the chrome link is back
	const page = report.pages.find((p) => p.url === `${SOUP}/`)!;
	assertEquals(page.ok, true);
	assertEquals(page.error, undefined);
	assertEquals(page.links.map((l) => l.to), [
		`${SOUP}/canon`,
		`${SOUP}/base/chrome`,
		`${SOUP}/base/content`,
	]);

	const warnings = logger.messages("warn").filter((m) => m.includes("beforeExtract"));
	assertEquals(warnings.length, 1, warnings.join("\n"));
});

Deno.test("followCanonical — recorded by default, enqueued only when asked", async () => {
	const off = await crawl(`${SOUP}/`, { fetcher: siteFetch(SOUP_SITE), maxDepth: 1 });
	const canonicalEdge = off.graph.find((e) => e.rel === "canonical")!;
	assertEquals(canonicalEdge.to, `${SOUP}/canon`);
	assertEquals(canonicalEdge.followed, false);
	assertEquals(canonicalEdge.skipReason, "excluded");

	const fake = siteFetch(SOUP_SITE);
	await crawl(`${SOUP}/`, { fetcher: fake, followCanonical: true, maxDepth: 1 });
	assert(fake.calls.some((c) => c.url === `${SOUP}/canon`));
});

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0"))
		.join("");
}

// -----------------------------------------------------------------------------------
// robots.txt — the gate
// -----------------------------------------------------------------------------------

Deno.test("robots — a disallowed path is skipped, and recorded as robots-disallow", async () => {
	const fake = siteFetch(SMALL_SITE);
	const report = await crawl(`${SITE}/`, { fetcher: fake });

	assertFalse(fake.calls.some((c) => c.url === `${SITE}/private/secret`));
	const edge = report.graph.find((e) => e.to === `${SITE}/private/secret`)!;
	assertEquals(edge.followed, false);
	assertEquals(edge.skipReason, "robots-disallow");
	assertEquals(report.stats.skippedByReason["robots-disallow"], 1);

	// and everything robots.txt did NOT disallow was crawled as usual
	assert(fake.calls.some((c) => c.url === `${SITE}/a`));
});

Deno.test("robots — one fetch per origin, however many links reach it", async () => {
	const fake = siteFetch(SMALL_SITE);
	await crawl(`${SITE}/`, { fetcher: fake, concurrency: 5 });

	assertEquals(fake.calls.filter((c) => c.url === `${SITE}/robots.txt`).length, 1);
	// it is also the very first thing asked for — the seed goes through the gate too
	assertEquals(fake.calls[0].url, `${SITE}/robots.txt`);
});

Deno.test("robots — a disallowed seed is refused, loudly", async () => {
	const logger = recordingLogger();
	const fake = siteFetch(SMALL_SITE);
	const report = await crawl(`${SITE}/private/secret`, { fetcher: fake, logger });

	assertEquals(report.pages, []);
	assertEquals(report.stats.skippedByReason["robots-disallow"], 1);
	assertEquals(
		logger.messages("warn").filter((m) => m.includes("robots-disallow")).length,
		1,
	);
});

Deno.test("robots — respect:false ignores the rules and warns exactly once", async () => {
	const logger = recordingLogger();
	const fake = siteFetch(SMALL_SITE);
	await crawl(`${SITE}/`, { fetcher: fake, logger, robots: { respect: false } });

	assert(fake.calls.some((c) => c.url === `${SITE}/private/secret`));
	// not even fetched — an ignored robots.txt is not worth a request
	assertFalse(fake.calls.some((c) => c.url === `${SITE}/robots.txt`));
	const warnings = logger.messages("warn").filter((m) => m.includes("robots.respect"));
	assertEquals(warnings.length, 1, warnings.join("\n"));
});

Deno.test("robots — 5xx disallows the whole origin; 4xx and errors allow it", async () => {
	const page = { html: `<title>x</title><a href="/other">other</a>` };

	const logger = recordingLogger();
	const down = siteFetch({
		"http://down.test/robots.txt": { status: 503, contentType: "text/plain" },
		"http://down.test/": page,
		"http://down.test/other": page,
	});
	const blocked = await crawl("http://down.test/", { fetcher: down, logger });
	assertEquals(blocked.pages, []);
	assertEquals(blocked.stats.skippedByReason["robots-disallow"], 1);
	assertEquals(
		logger.messages("warn").filter((m) => m.includes("503")).length,
		1,
		"a 5xx robots.txt warns once for its origin",
	);

	// 404: SMALL_SITE's fake answers unknown URLs with one, so any other host is the
	// "no robots.txt at all" case
	const open = siteFetch({ "http://open.test/": page, "http://open.test/other": page });
	const allowed = await crawl("http://open.test/", { fetcher: open });
	assertEquals(allowed.pages.length, 2);

	// a transport error is indistinguishable from "no rules", so it fails open too
	const broken = siteFetch({
		"http://broken.test/robots.txt": { error: { kind: "network" } },
		"http://broken.test/": page,
		"http://broken.test/other": page,
	});
	const survived = await crawl("http://broken.test/", { fetcher: broken });
	assertEquals(survived.pages.length, 2);
});

Deno.test("robots — a robots.txt served as HTML is read as no rules", async () => {
	// the SPA catch-all route: a 200 that is really the app shell
	const fake = siteFetch({
		"http://spa.test/robots.txt": {
			contentType: "text/html",
			html: `<!doctype html><title>App</title><p>Disallow: /</p>`,
		},
		"http://spa.test/": { html: `<title>x</title><a href="/other">other</a>` },
		"http://spa.test/other": { html: `<title>other</title>` },
	});
	const report = await crawl("http://spa.test/", { fetcher: fake });

	assertEquals(report.pages.length, 2);
	assertEquals(report.stats.skippedByReason["robots-disallow"], undefined);
});

Deno.test("robots — Crawl-delay feeds the scheduler, capped", async () => {
	const starts: number[] = [];
	const inner = siteFetch({
		"http://slow.test/robots.txt": {
			contentType: "text/plain",
			html: `User-agent: *\nCrawl-delay: 10\n`,
		},
		"http://slow.test/": {
			html: `<title>x</title><a href="/a">a</a><a href="/b">b</a>`,
		},
		"http://slow.test/a": { html: `<title>a</title>` },
		"http://slow.test/b": { html: `<title>b</title>` },
	});
	const report = await crawl("http://slow.test/", {
		fetcher: (req) => {
			if (!req.url.endsWith("/robots.txt")) starts.push(Date.now());
			return inner(req);
		},
		// 10 seconds asked for, 40ms honored — the cap is what makes this testable, and
		// is also the only thing between a crawl and a robots.txt asking for an hour
		robots: { crawlDelayCap: 40, fetch: inner },
		perHostConcurrency: 1,
	});

	assertEquals(report.pages.length, 3);
	assertEquals(starts.length, 3);
	for (let i = 1; i < starts.length; i++) {
		assert(
			starts[i] - starts[i - 1] >= 35,
			`gap ${i} was ${starts[i] - starts[i - 1]}ms`,
		);
	}
});

// -----------------------------------------------------------------------------------
// robots.txt — the per-page directives
// -----------------------------------------------------------------------------------

const DIRECTIVE = "http://directive.test";

Deno.test("meta robots — nofollow stops expansion, noindex is only recorded", async () => {
	const fake = siteFetch({
		[`${DIRECTIVE}/`]: {
			html: `<head><meta name="robots" content="noindex, nofollow"></head>
				<a href="/a">a</a><a href="/b">b</a>`,
		},
		[`${DIRECTIVE}/a`]: { html: `<title>a</title>` },
		[`${DIRECTIVE}/b`]: { html: `<title>b</title>` },
	});
	const report = await crawl(`${DIRECTIVE}/`, { fetcher: fake });

	const page = report.pages[0];
	assertEquals(page.robots, { noindex: true, nofollow: true });
	// noindex is not the crawler's business — the page was still fetched and reported
	assertEquals(page.ok, true);

	assertEquals(page.links.map((l) => [l.to, l.nofollow, l.skipReason]), [
		[`${DIRECTIVE}/a`, true, "nofollow"],
		[`${DIRECTIVE}/b`, true, "nofollow"],
	]);
	assertEquals(report.stats.skippedByReason.nofollow, 2);
	assertFalse(fake.calls.some((c) => c.url === `${DIRECTIVE}/a`));
});

Deno.test("X-Robots-Tag — the header does what the meta tag does", async () => {
	const fake = siteFetch({
		[`${DIRECTIVE}/`]: {
			headers: { "x-robots-tag": "noindex, nofollow" },
			html: `<a href="/a">a</a>`,
		},
		[`${DIRECTIVE}/a`]: { html: `<title>a</title>` },
	});
	const report = await crawl(`${DIRECTIVE}/`, { fetcher: fake });

	assertEquals(report.pages[0].robots, { noindex: true, nofollow: true });
	assertEquals(report.pages[0].links[0].skipReason, "nofollow");
});

Deno.test("X-Robots-Tag — applies to a non-HTML response too", async () => {
	const fake = siteFetch({
		[`${DIRECTIVE}/data.json`]: {
			contentType: "application/json",
			headers: { "x-robots-tag": "noindex" },
			html: `{"a":1}`,
		},
	});
	const report = await crawl(`${DIRECTIVE}/data.json`, { fetcher: fake });

	// nothing was parsed for links, but the directive is still on the record
	assertEquals(report.pages[0].links, []);
	assertEquals(report.pages[0].robots, { noindex: true, nofollow: false });
});

Deno.test("robots directives — merged most-restrictive-wins, and absent when silent", async () => {
	const fake = siteFetch({
		[`${DIRECTIVE}/`]: {
			headers: { "x-robots-tag": "noindex" },
			html:
				`<head><meta name="robots" content="nofollow"></head><a href="/a">a</a>`,
		},
		[`${DIRECTIVE}/quiet`]: { html: `<title>quiet</title>` },
	});

	const merged = await crawl(`${DIRECTIVE}/`, { fetcher: fake });
	assertEquals(merged.pages[0].robots, { noindex: true, nofollow: true });

	const quiet = await crawl(`${DIRECTIVE}/quiet`, { fetcher: siteFetch(SMALL_SITE) });
	assertEquals(quiet.pages[0].robots, undefined);
});

Deno.test("followNofollow — overrides both the rel and the page directive", async () => {
	const fake = siteFetch({
		[`${DIRECTIVE}/`]: {
			html:
				`<head><meta name="robots" content="nofollow"></head><a href="/a">a</a>`,
		},
		[`${DIRECTIVE}/a`]: { html: `<title>a</title>` },
	});
	await crawl(`${DIRECTIVE}/`, { fetcher: fake, scope: { followNofollow: true } });

	assert(fake.calls.some((c) => c.url === `${DIRECTIVE}/a`));
});
