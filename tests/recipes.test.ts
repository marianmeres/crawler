/**
 * The shipped recipes, where they are testable.
 *
 * `examples/` is the package's public face and doubles as its API-ergonomics review, so
 * the two recipes that export a pure report builder are held to their output here: a
 * `SMALL_SITE` crawl over the fake transport goes in, the report a consumer would print
 * comes out. The PG, browser and steve recipes are not auto-tested — the PG suites and
 * the steve e2e cover those paths, and a browser is never a dependency.
 *
 * Importing the examples at all is half the point: it proves they are importable, i.e.
 * that each guards its runnable half behind `import.meta.main` instead of crawling
 * something the moment it is loaded.
 *
 * @module
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { crawl } from "../src/crawler.ts";
import type { PageResult } from "../src/types.ts";
import { type MiniSite, SITE, siteFetch, SMALL_SITE } from "./_helpers.ts";
import { brokenLinkReport } from "../example/recipes/broken-links.ts";
import { type SitemapPageData, sitemapXml } from "../example/recipes/sitemap-gen.ts";

const HOME = `${SITE}/`;

/** `robots.respect: false`: what robots.txt does has its own suite. */
function crawlFixture(site: MiniSite, options: Parameters<typeof crawl>[1] = {}) {
	return crawl(HOME, {
		fetcher: siteFetch(site),
		robots: { respect: false },
		concurrency: 1,
		...options,
	});
}

/** A minimal, plausible {@linkcode PageResult}, for asserting the helpers in isolation. */
function page(init: Partial<PageResult> & { url: string }): PageResult {
	return {
		crawlId: "test",
		requestId: "test",
		finalUrl: init.url,
		redirects: [],
		status: 200,
		ok: true,
		contentType: "text/html; charset=utf-8",
		depth: 0,
		discoveredVia: "link",
		attempts: 1,
		timing: { total: 0, fetch: 0, extract: 0 },
		fromCache: false,
		notModified: false,
		links: [],
		...init,
	};
}

Deno.test("recipe broken-links: a healthy site has no dead targets", async () => {
	const report = await crawlFixture(SMALL_SITE, {
		extract: { assets: true },
		scope: { checkExternal: true },
	});

	assertEquals(brokenLinkReport(report.graph, report.pages), []);
});

Deno.test("recipe broken-links: dead targets group the pages that link to them", async () => {
	const site: MiniSite = {
		...SMALL_SITE,
		[`${SITE}/a`]: { html: `<a href="/b">b</a><a href="/gone">gone</a>` },
		[`${SITE}/b`]: {
			html: `<a href="/a">a</a><a href="/gone">gone too</a><img src="/logo.png">`,
		},
	};

	const report = await crawlFixture(site, { extract: { assets: true } });

	// most-linked first, and every referrer listed — that is the whole report
	assertEquals(brokenLinkReport(report.graph, report.pages), [
		{ url: `${SITE}/gone`, status: 404, from: [`${SITE}/a`, `${SITE}/b`] },
		{ url: `${SITE}/logo.png`, status: 404, from: [`${SITE}/b`] },
	]);
});

Deno.test("recipe sitemap-gen: one <loc> per reachable page, at its final URL", async () => {
	const report = await crawlFixture(SMALL_SITE);
	const xml = sitemapXml(report.pages);

	assertStringIncludes(xml, `<?xml version="1.0" encoding="UTF-8"?>`);
	assertStringIncludes(
		xml,
		`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`,
	);
	assert(xml.trimEnd().endsWith("</urlset>"));

	assertEquals(
		locs(xml).sort(),
		[
			HOME,
			`${SITE}/a`,
			`${SITE}/b`,
			`${SITE}/dup`,
			`${SITE}/private/secret`,
			// `/redirect` was crawled; `/target` is where it went, and that is what a
			// sitemap should advertise
			`${SITE}/target`,
			`${SITE}/t/a/b/a/b/a/b`,
		].sort(),
	);
});

Deno.test("recipe sitemap-gen: lastmod, escaping, and what stays out", () => {
	const xml = sitemapXml([
		page({ url: `${SITE}/x?a=1&b=2`, data: { lastmod: "2026-08-25" } }),
		page({ url: `${SITE}/dupe`, finalUrl: `${SITE}/x?a=1&b=2` }),
		page({ url: `${SITE}/hidden`, robots: { noindex: true } }),
		page({ url: `${SITE}/gone`, status: 404, ok: false }),
		page({ url: `${SITE}/moved`, status: 301, ok: false }),
		page({ url: `${SITE}/doc.pdf`, contentType: "application/pdf" }),
		page({ url: `${SITE}/canonicalized`, canonical: `${SITE}/canonical` }),
	]);

	assertEquals(locs(xml), [`${SITE}/x?a=1&amp;b=2`, `${SITE}/canonical`]);
	assertStringIncludes(xml, `<lastmod>2026-08-25</lastmod>`);
});

Deno.test("recipe sitemap-gen: the example's own page data type is what it reads", () => {
	const data: SitemapPageData = { lastmod: "2026-01-02" };
	assertStringIncludes(
		sitemapXml([page({ url: HOME, data })]),
		`<loc>${HOME}</loc><lastmod>2026-01-02</lastmod>`,
	);
});

function locs(xml: string): string[] {
	return [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map(([, url]) => url);
}
