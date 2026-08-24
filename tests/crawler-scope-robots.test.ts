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
	assertEquals(fake.calls.map((c) => c.url), [`${SITE}/`, `${SITE}/a`]);
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

	assertEquals(fake.calls.map((c) => c.url), [`${REGION}/`, `${REGION}/main`]);
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
	assertEquals(fake.calls.length, 3);
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
