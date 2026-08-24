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
	"isSameSite",
	"normalizeUrl",
];

const EXTRACT_EXPORTS = [
	"DEFAULT_EXTRACT_OPTIONS",
	"DEFAULT_TITLE_MAX_LENGTH",
	"extractBaseHref",
	"extractLinks",
	"extractTitle",
	"parseRobotsTxt",
	"robotsAllowAll",
	"robotsDisallowAll",
];

const URL_EXPORTS = [
	"DEFAULT_ALLOW_SCHEMES",
	"DEFAULT_STRIP_PARAMS",
	"SECOND_LEVEL_LABELS",
	"classifyLink",
	"getRegistrableDomain",
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

Deno.test("stores/mod.ts — is type-only for now", () => {
	assertEquals(runtimeExportsOf(stores), []);
});
