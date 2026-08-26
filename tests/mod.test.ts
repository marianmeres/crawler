import { assertEquals } from "@std/assert";
import * as root from "../src/mod.ts";
import * as url from "../src/url/mod.ts";
import * as extract from "../src/extract/mod.ts";
import * as stores from "../src/stores/mod.ts";

/**
 * The published runtime surface, pinned. Types are checked by `deno check`; what this
 * guards is the accidental *addition* — an `export *` quietly re-exporting a helper
 * marked `@internal`, which is exactly how a private symbol becomes a public promise.
 */
const ROOT_EXPORTS = [
	// entry points
	"crawl",
	"createCrawler",
	// documented constants
	"DEFAULT_ALLOW_SCHEMES",
	"DEFAULT_STRIP_PARAMS",
	"DEFAULT_USER_AGENT",
	"SECOND_LEVEL_LABELS",
	// ./url, re-exported for convenience
	"classifyLink",
	"getRegistrableDomain",
	"hostsAreSameSite",
	"isSameSite",
	"normalizeUrl",
];

const EXTRACT_EXPORTS = [
	"DEFAULT_EXTRACT_OPTIONS",
	"DEFAULT_TITLE_MAX_LENGTH",
	"extractBaseHref",
	"extractLinks",
	"extractTitle",
	"parseMetaRobots",
	"parseRobotsTxt",
	"parseSitemap",
	"parseXRobotsTag",
	"robotsAllowAll",
	"robotsDisallowAll",
];

const URL_EXPORTS = [
	"DEFAULT_ALLOW_SCHEMES",
	"DEFAULT_STRIP_PARAMS",
	"SECOND_LEVEL_LABELS",
	"classifyLink",
	"getRegistrableDomain",
	"hostsAreSameSite",
	"isSameSite",
	"normalizeUrl",
];

function runtimeExportsOf(mod: Record<string, unknown>): string[] {
	return Object.keys(mod).filter((k) => k !== "default").sort();
}

Deno.test("mod.ts — exports exactly the documented runtime surface", () => {
	assertEquals(runtimeExportsOf(root), [...ROOT_EXPORTS].sort());
});

Deno.test("url/mod.ts — exports exactly the documented runtime surface", () => {
	assertEquals(runtimeExportsOf(url), [...URL_EXPORTS].sort());
});

Deno.test("extract/mod.ts — exports exactly the documented runtime surface", () => {
	assertEquals(runtimeExportsOf(extract), [...EXTRACT_EXPORTS].sort());
});

const STORES_EXPORTS = [
	"createMemoryFrontier",
	"createMemoryVisited",
];

Deno.test("stores/mod.ts — exports exactly the documented runtime surface", () => {
	assertEquals(runtimeExportsOf(stores), [...STORES_EXPORTS].sort());
});

/**
 * The rest of the suite imports by relative path, which is convenient and proves
 * nothing about packaging. This one resolves through the *published* specifiers — the
 * `exports` map, reached via the self-referencing `imports` entries in `deno.json` —
 * so a subpath that is declared but does not resolve fails here rather than at
 * `deno publish`. It is also what makes the "usable standalone" claim on `./url` and
 * `./extract` an assertion instead of a sentence in a README.
 */
Deno.test("the published subpaths resolve, and to the same modules", async () => {
	const [pkgRoot, pkgUrl, pkgExtract, pkgStores] = await Promise.all([
		import("@marianmeres/crawler"),
		import("@marianmeres/crawler/url"),
		import("@marianmeres/crawler/extract"),
		import("@marianmeres/crawler/stores"),
	]);

	assertEquals(runtimeExportsOf(pkgRoot), [...ROOT_EXPORTS].sort());
	assertEquals(runtimeExportsOf(pkgUrl), [...URL_EXPORTS].sort());
	assertEquals(runtimeExportsOf(pkgExtract), [...EXTRACT_EXPORTS].sort());
	assertEquals(runtimeExportsOf(pkgStores), [...STORES_EXPORTS].sort());

	// the same module instance, not a second copy of the graph
	assertEquals(pkgUrl.normalizeUrl, url.normalizeUrl);
	assertEquals(pkgExtract.extractLinks, extract.extractLinks);
	assertEquals(pkgStores.createMemoryFrontier, stores.createMemoryFrontier);

	// and they actually work when reached that way
	assertEquals(
		pkgUrl.normalizeUrl("https://Ex.com/a/?b=2&a=1"),
		"https://ex.com/a?a=1&b=2",
	);
	assertEquals(
		pkgExtract.extractLinks(`<a href="/x">t</a>`, "https://a.com/")[0].url,
		"https://a.com/x",
	);
});
