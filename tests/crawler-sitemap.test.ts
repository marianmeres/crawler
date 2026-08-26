/**
 * `robots.sitemaps`: seeding the frontier from an origin's `Sitemap:` lines.
 *
 * The fixture site's `/sitemap-only` is reachable **only** through the sitemap — nothing
 * in the markup links to it — so its presence in a report is proof the seeding ran, and
 * its absence with the option off is proof the option is what turned it on.
 *
 * The rest of the suite is about the ways the feature is bounded, because every one of
 * them is a promise made to somebody's server: one level of `<sitemapindex>`, 50
 * documents per origin, same-origin only, and the same scope/robots pipeline every other
 * candidate URL goes through. The gunzip path is unit-tested directly — the fake
 * transport carries strings, so a compressed body has no way through it.
 *
 * @module
 */

import { assert, assertEquals, assertFalse } from "@std/assert";
import { crawl } from "../src/crawler.ts";
import { decodeSitemapBody } from "../src/engine/dispatcher.ts";
import {
	type MiniSite,
	recordingLogger,
	SITE,
	siteFetch,
	SMALL_SITE,
} from "./_helpers.ts";

/** `<urlset>` over the given locs. */
const urlset = (...locs: string[]) => ({
	contentType: "application/xml",
	html: `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${locs.map((loc) => `\t<url><loc>${loc}</loc></url>`).join("\n")}
</urlset>`,
});

/** `<sitemapindex>` over the given child documents. */
const sitemapindex = (...locs: string[]) => ({
	contentType: "application/xml",
	html: `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${locs.map((loc) => `\t<sitemap><loc>${loc}</loc></sitemap>`).join("\n")}
</sitemapindex>`,
});

/** A robots.txt naming the given sitemap URLs and nothing else. */
const robots = (...sitemaps: string[]) => ({
	contentType: "text/plain",
	html: sitemaps.map((url) => `Sitemap: ${url}`).join("\n"),
});

/** A page with no links. */
const leaf = { html: `<title>leaf</title>` };

// ------------------------------------------------------------------------------------
// the headline: a URL nothing links to
// ------------------------------------------------------------------------------------

Deno.test("robots.sitemaps: seeds URLs that no page links to", async (t) => {
	const logger = recordingLogger();
	const fetcher = siteFetch(SMALL_SITE);
	const report = await crawl(`${SITE}/`, {
		fetcher,
		logger,
		robots: { sitemaps: true },
	});

	const page = report.pages.find((p) => p.url === `${SITE}/sitemap-only`);

	await t.step("the page was crawled", () => {
		assert(page !== undefined, "the sitemap URL never became a page");
		assertEquals(page.status, 200);
		assertEquals(page.title, "Sitemap only");
	});

	await t.step("and is attributed to the sitemap, at depth 0", () => {
		assertEquals(page!.discoveredVia, "sitemap");
		assertEquals(page!.depth, 0);
	});

	await t.step("the sitemap document itself is fetched, but is not a page", () => {
		assert(fetcher.calls.some((c) => c.url === `${SITE}/sitemap.xml`));
		assertFalse(report.pages.some((p) => p.url === `${SITE}/sitemap.xml`));
	});

	await t.step("the warn-once 'not implemented' stub is gone", () => {
		assertFalse(
			logger.messages("warn").some((m) => m.includes("robots.sitemaps")),
			logger.messages("warn").join("\n"),
		);
	});

	await t.step("the crawl still ends on its own", () => {
		assertEquals(report.stoppedBy, "completed");
	});
});

Deno.test("robots.sitemaps: off by default — the same site, the same seed", async () => {
	const fetcher = siteFetch(SMALL_SITE);
	const report = await crawl(`${SITE}/`, { fetcher });

	assertFalse(report.pages.some((p) => p.url === `${SITE}/sitemap-only`));
	assertFalse(fetcher.calls.some((c) => c.url === `${SITE}/sitemap.xml`));
});

// ------------------------------------------------------------------------------------
// sitemapindex
// ------------------------------------------------------------------------------------

Deno.test("robots.sitemaps: a sitemapindex is followed exactly one level", async (t) => {
	const site: MiniSite = {
		[`${SITE}/robots.txt`]: robots(`${SITE}/index.xml`),
		[`${SITE}/index.xml`]: sitemapindex(`${SITE}/child.xml`, `${SITE}/nested.xml`),
		[`${SITE}/child.xml`]: urlset(`${SITE}/from-child`),
		// a second level of index: fetched, but its own children are not
		[`${SITE}/nested.xml`]: sitemapindex(`${SITE}/deep.xml`),
		[`${SITE}/deep.xml`]: urlset(`${SITE}/from-deep`),
		[`${SITE}/from-child`]: leaf,
		[`${SITE}/from-deep`]: leaf,
	};
	const fetcher = siteFetch(site);
	const report = await crawl(`${SITE}/from-child`, {
		fetcher,
		robots: { sitemaps: true },
	});

	await t.step("the first level's URLs are crawled", () => {
		assert(report.pages.some((p) => p.url === `${SITE}/from-child`));
	});

	await t.step("the second level's are not, and are never fetched", () => {
		assertFalse(report.pages.some((p) => p.url === `${SITE}/from-deep`));
		assertFalse(fetcher.calls.some((c) => c.url === `${SITE}/deep.xml`));
	});
});

Deno.test("robots.sitemaps: at most 50 documents per origin, and it says so", async () => {
	const children = Array.from({ length: 60 }, (_, i) => `${SITE}/s${i}.xml`);
	const site: MiniSite = {
		[`${SITE}/robots.txt`]: robots(`${SITE}/index.xml`),
		[`${SITE}/index.xml`]: sitemapindex(...children),
		[`${SITE}/seed`]: leaf,
	};
	for (const [i, url] of children.entries()) site[url] = urlset(`${SITE}/p${i}`);
	for (let i = 0; i < 60; i++) site[`${SITE}/p${i}`] = leaf;

	const logger = recordingLogger();
	const fetcher = siteFetch(site);
	const report = await crawl(`${SITE}/seed`, {
		fetcher,
		logger,
		robots: { sitemaps: true },
	});

	// the index counts against the budget, so 49 of its 60 children are read
	const documents = fetcher.calls.filter((c) => c.url.endsWith(".xml"));
	assertEquals(documents.length, 50);
	assertEquals(report.pages.filter((p) => p.discoveredVia === "sitemap").length, 49);
	assert(
		logger.messages("warn").some((m) => m.includes("more than 50 sitemap")),
		logger.messages("warn").join("\n"),
	);
});

// ------------------------------------------------------------------------------------
// bounds
// ------------------------------------------------------------------------------------

Deno.test("robots.sitemaps: a cross-origin sitemap document is ignored", async () => {
	const site: MiniSite = {
		[`${SITE}/robots.txt`]: robots("http://ext.test/sitemap.xml"),
		[`${SITE}/seed`]: leaf,
		"http://ext.test/sitemap.xml": urlset(`${SITE}/would-be-seeded`),
		[`${SITE}/would-be-seeded`]: leaf,
	};
	const logger = recordingLogger();
	const fetcher = siteFetch(site);
	const report = await crawl(`${SITE}/seed`, {
		fetcher,
		logger,
		robots: { sitemaps: true },
	});

	assertFalse(fetcher.calls.some((c) => c.url === "http://ext.test/sitemap.xml"));
	assertFalse(report.pages.some((p) => p.url === `${SITE}/would-be-seeded`));
	assert(
		logger.messages("warn").some((m) => m.includes("cross-origin sitemap")),
		logger.messages("warn").join("\n"),
	);
});

Deno.test("robots.sitemaps: listed URLs still face the whole pipeline", async (t) => {
	const site: MiniSite = {
		[`${SITE}/robots.txt`]: {
			contentType: "text/plain",
			html: `User-agent: *
Disallow: /private/

Sitemap: ${SITE}/sitemap.xml`,
		},
		[`${SITE}/sitemap.xml`]: urlset(
			`${SITE}/ok`,
			`${SITE}/private/secret`,
			`${SITE}/excluded`,
			"http://ext.test/off-site",
			"javascript:void(0)",
		),
		[`${SITE}/seed`]: leaf,
		[`${SITE}/ok`]: leaf,
		[`${SITE}/private/secret`]: leaf,
		[`${SITE}/excluded`]: leaf,
		"http://ext.test/off-site": leaf,
	};
	const fetcher = siteFetch(site);
	const report = await crawl(`${SITE}/seed`, {
		fetcher,
		robots: { sitemaps: true },
		scope: { exclude: ["/excluded"] },
	});

	const crawled = report.pages.map((p) => p.url).sort();

	await t.step("an allowed, in-scope URL is crawled", () => {
		assertEquals(crawled, [`${SITE}/ok`, `${SITE}/seed`]);
	});

	await t.step("and every rejection is counted under its own reason", () => {
		const skips = report.stats.skippedByReason;
		assertEquals(skips["robots-disallow"], 1);
		assertEquals(skips["excluded"], 1);
		assertEquals(skips["out-of-scope"], 1);
		assertEquals(skips["bad-scheme"], 1);
	});
});

Deno.test("robots.sitemaps: an unreadable sitemap is a warning, not a failure", async () => {
	const site: MiniSite = {
		[`${SITE}/robots.txt`]: robots(`${SITE}/missing.xml`),
		[`${SITE}/seed`]: leaf,
	};
	const logger = recordingLogger();
	const report = await crawl(`${SITE}/seed`, {
		fetcher: siteFetch(site),
		logger,
		robots: { sitemaps: true },
	});

	assertEquals(report.stoppedBy, "completed");
	assertEquals(report.pages.map((p) => p.url), [`${SITE}/seed`]);
	assert(
		logger.messages("warn").some((m) => m.includes("answered 404")),
		logger.messages("warn").join("\n"),
	);
});

Deno.test("robots.sitemaps: read without respecting the rules", async () => {
	// `{ respect: false, sitemaps: true }` still has to fetch robots.txt — the Sitemap:
	// lines are in it — while ignoring what it disallows
	const site: MiniSite = {
		[`${SITE}/robots.txt`]: {
			contentType: "text/plain",
			html: `User-agent: *\nDisallow: /\n\nSitemap: ${SITE}/sitemap.xml`,
		},
		[`${SITE}/sitemap.xml`]: urlset(`${SITE}/listed`),
		[`${SITE}/seed`]: leaf,
		[`${SITE}/listed`]: leaf,
	};
	const report = await crawl(`${SITE}/seed`, {
		fetcher: siteFetch(site),
		robots: { respect: false, sitemaps: true },
	});

	assertEquals(report.pages.map((p) => p.url).sort(), [
		`${SITE}/listed`,
		`${SITE}/seed`,
	]);
});

// ------------------------------------------------------------------------------------
// gzip
// ------------------------------------------------------------------------------------

Deno.test("decodeSitemapBody", async (t) => {
	const xml = `<urlset><url><loc>https://a.test/x</loc></url></urlset>`;

	async function gzip(text: string): Promise<Uint8Array> {
		const stream = new Blob([text]).stream()
			.pipeThrough(new CompressionStream("gzip"));
		return new Uint8Array(await new Response(stream).arrayBuffer());
	}

	await t.step("a gzipped body is gunzipped", async () => {
		const bytes = await gzip(xml);
		// the fixture really is gzip, or the test would prove nothing
		assertEquals([bytes[0], bytes[1]], [0x1f, 0x8b]);
		assertEquals(await decodeSitemapBody(bytes), xml);
	});

	await t.step("a plain body is decoded as UTF-8", async () => {
		const bytes = new TextEncoder().encode(`<loc>https://a.test/ünï</loc>`);
		assertEquals(await decodeSitemapBody(bytes), `<loc>https://a.test/ünï</loc>`);
	});

	await t.step("an empty body is not mistaken for gzip", async () => {
		assertEquals(await decodeSitemapBody(new Uint8Array(0)), "");
	});
});
