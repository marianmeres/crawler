/**
 * `parseSitemap`: the two XML kinds, the plain-text format, and the tolerances.
 *
 * The suite is written against the *shapes real generators emit* rather than against the
 * schema — namespace prefixes, CDATA, entity-escaped query strings, a truncated document,
 * an HTML error page served at `/sitemap.xml` — because the schema-conforming case is the
 * one that was never going to break.
 *
 * The last step is a fuzz pass: the parser's whole contract is "never throws", and a
 * contract that is only asserted on hand-written inputs is asserted on the inputs the
 * author already thought of.
 *
 * @module
 */

import { assert, assertEquals } from "@std/assert";
import { parseSitemap } from "../../src/extract/sitemap.ts";
import type { SitemapEntry, SitemapParseResult } from "../../src/extract/sitemap.ts";

/** The `<loc>` values of a urlset, or a failure when the kind was not that. */
function urlsOf(text: string): string[] {
	const result = parseSitemap(text);
	assertEquals(result.kind, "urlset");
	assert(result.kind === "urlset");
	return result.entries.map((e) => e.url);
}

/** The `<loc>` values of a sitemapindex, or a failure when the kind was not that. */
function indexOf_(text: string): string[] {
	const result = parseSitemap(text);
	assertEquals(result.kind, "sitemapindex");
	assert(result.kind === "sitemapindex");
	return result.sitemaps.map((e) => e.url);
}

function entriesOf(text: string): SitemapEntry[] {
	const result = parseSitemap(text);
	assert(result.kind === "urlset");
	return result.entries;
}

const URLSET = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
	<url>
		<loc>https://example.com/</loc>
		<lastmod>2026-08-25T10:00:00+02:00</lastmod>
		<changefreq>daily</changefreq>
		<priority>1.0</priority>
	</url>
	<url>
		<loc>https://example.com/a</loc>
	</url>
</urlset>`;

// ------------------------------------------------------------------------------------
// urlset
// ------------------------------------------------------------------------------------

Deno.test("parseSitemap: urlset", async (t) => {
	await t.step("every field of a conforming document", () => {
		assertEquals(entriesOf(URLSET), [
			{
				url: "https://example.com/",
				lastmod: "2026-08-25T10:00:00+02:00",
				changefreq: "daily",
				priority: 1,
			},
			{ url: "https://example.com/a" },
		]);
	});

	await t.step("a block with no <loc>, or an empty one, is dropped", () => {
		assertEquals(
			urlsOf(`<urlset>
				<url><lastmod>2026-01-01</lastmod></url>
				<url><loc>   </loc></url>
				<url><loc/></url>
				<url><loc>https://example.com/kept</loc></url>
			</urlset>`),
			["https://example.com/kept"],
		);
	});

	await t.step("a non-numeric priority is dropped rather than kept as NaN", () => {
		const [entry] = entriesOf(
			`<urlset><url><loc>https://a.test/</loc><priority>high</priority></url></urlset>`,
		);
		assertEquals(entry, { url: "https://a.test/" });
		assert(!("priority" in entry));
	});

	await t.step("unclosed <url> blocks still yield their locs", () => {
		assertEquals(
			urlsOf(`<urlset>
				<url><loc>https://a.test/1</loc>
				<url><loc>https://a.test/2</loc>
				<url><loc>https://a.test/3</loc>`),
			["https://a.test/1", "https://a.test/2", "https://a.test/3"],
		);
	});

	await t.step("a document truncated mid-tag loses only the last entry", () => {
		assertEquals(
			urlsOf(`<urlset><url><loc>https://a.test/1</loc></url><url><loc>https:`),
			["https://a.test/1", "https:"],
		);
	});
});

// ------------------------------------------------------------------------------------
// sitemapindex
// ------------------------------------------------------------------------------------

Deno.test("parseSitemap: sitemapindex", async (t) => {
	await t.step("children and their lastmod", () => {
		const result = parseSitemap(`<?xml version="1.0"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
	<sitemap><loc>https://example.com/s1.xml</loc><lastmod>2026-08-01</lastmod></sitemap>
	<sitemap><loc>https://example.com/s2.xml.gz</loc></sitemap>
</sitemapindex>`);
		assert(result.kind === "sitemapindex");
		assertEquals(result.sitemaps, [
			{ url: "https://example.com/s1.xml", lastmod: "2026-08-01" },
			{ url: "https://example.com/s2.xml.gz" },
		]);
	});

	await t.step("the root that appears first decides the kind", () => {
		// a `<urlset>` mentioned in a comment after the real root must not win
		assertEquals(
			indexOf_(
				`<sitemapindex><sitemap><loc>https://a.test/s.xml</loc></sitemap>` +
					`<urlset><url><loc>https://a.test/x</loc></url></urlset></sitemapindex>`,
			),
			["https://a.test/s.xml"],
		);
	});

	await t.step("<sitemapindex> is not read as a <sitemap> block", () => {
		assertEquals(
			indexOf_(`<sitemapindex><loc>https://a.test/x</loc></sitemapindex>`),
			[],
		);
	});
});

// ------------------------------------------------------------------------------------
// tolerances
// ------------------------------------------------------------------------------------

Deno.test("parseSitemap: namespace prefixes", async (t) => {
	await t.step("on the root and on every child", () => {
		assertEquals(
			urlsOf(`<sm:urlset xmlns:sm="http://www.sitemaps.org/schemas/sitemap/0.9">
				<sm:url><sm:loc>https://a.test/x</sm:loc></sm:url>
			</sm:urlset>`),
			["https://a.test/x"],
		);
	});

	await t.step("on a sitemapindex", () => {
		assertEquals(
			indexOf_(
				`<ns:sitemapindex><ns:sitemap><ns:loc>https://a.test/s.xml</ns:loc>` +
					`</ns:sitemap></ns:sitemapindex>`,
			),
			["https://a.test/s.xml"],
		);
	});

	await t.step("a longer name ending in the same suffix does not match", () => {
		// `<myurl>` is not a `<url>`, and `<urlset>` is not one either
		assertEquals(
			urlsOf(`<urlset><myurl><loc>https://a.test/x</loc></myurl></urlset>`),
			[],
		);
	});
});

Deno.test("parseSitemap: CDATA and entities", async (t) => {
	await t.step("CDATA is unwrapped", () => {
		assertEquals(
			urlsOf(
				`<urlset><url><loc><![CDATA[https://a.test/x?a=1]]></loc></url></urlset>`,
			),
			["https://a.test/x?a=1"],
		);
	});

	await t.step("an unterminated CDATA keeps what it had", () => {
		assertEquals(
			urlsOf(`<urlset><url><loc><![CDATA[https://a.test/x</loc></url></urlset>`),
			["https://a.test/x"],
		);
	});

	await t.step("&amp; in a query string is decoded — it is a different URL", () => {
		assertEquals(
			urlsOf(
				`<urlset><url><loc>https://a.test/x?a=1&amp;b=2&#38;c=3</loc></url></urlset>`,
			),
			["https://a.test/x?a=1&b=2&c=3"],
		);
	});

	await t.step("entities inside CDATA are decoded too", () => {
		assertEquals(
			urlsOf(
				`<urlset><url><loc><![CDATA[https://a.test/x?a=1&amp;b=2]]></loc></url></urlset>`,
			),
			["https://a.test/x?a=1&b=2"],
		);
	});

	await t.step("surrounding whitespace and newlines are trimmed", () => {
		assertEquals(
			urlsOf(`<urlset><url><loc>\n\t  https://a.test/x  \n</loc></url></urlset>`),
			["https://a.test/x"],
		);
	});
});

Deno.test("parseSitemap: plain text", async (t) => {
	await t.step("one URL per line, comments and blanks skipped", () => {
		assertEquals(
			urlsOf(`# a comment

https://a.test/1
https://a.test/2
   https://a.test/3
`),
			["https://a.test/1", "https://a.test/2", "https://a.test/3"],
		);
	});

	await t.step("lines that are not http(s) URLs are skipped", () => {
		assertEquals(
			urlsOf("ftp://a.test/1\n/relative\nHTTPS://a.test/2\nnot a url"),
			["HTTPS://a.test/2"],
		);
	});

	await t.step("CRLF line endings", () => {
		assertEquals(urlsOf("https://a.test/1\r\nhttps://a.test/2"), [
			"https://a.test/1",
			"https://a.test/2",
		]);
	});

	await t.step("a single `<` anywhere turns the document into XML", () => {
		// the fallback is only for bodies with no markup at all: an HTML error page
		// listing URLs must not be read as a URL list
		assertEquals(urlsOf("https://a.test/1\n<p>https://a.test/2</p>"), []);
	});
});

Deno.test("parseSitemap: unrecognizable input reads as an empty urlset", async (t) => {
	const empty: SitemapParseResult = { kind: "urlset", entries: [] };

	await t.step("an HTML error page served at /sitemap.xml", () => {
		assertEquals(
			parseSitemap(`<!doctype html><html><body><h1>404</h1></body></html>`),
			empty,
		);
	});

	await t.step("an RSS feed — a legal sitemap format we do not read", () => {
		assertEquals(
			parseSitemap(
				`<rss><channel><item><link>https://a.test/x</link></item></channel></rss>`,
			),
			empty,
		);
	});

	await t.step("the empty string, and a non-string", () => {
		assertEquals(parseSitemap(""), empty);
		assertEquals(parseSitemap(undefined as unknown as string), empty);
		assertEquals(parseSitemap(42 as unknown as string), empty);
	});
});

Deno.test("parseSitemap: the 50 000-entry cap drops the tail", async (t) => {
	await t.step("urlset", () => {
		const block = `<url><loc>https://a.test/x</loc></url>`;
		const result = parseSitemap(`<urlset>${block.repeat(50_010)}</urlset>`);
		assert(result.kind === "urlset");
		assertEquals(result.entries.length, 50_000);
	});

	await t.step("sitemapindex", () => {
		const block = `<sitemap><loc>https://a.test/s.xml</loc></sitemap>`;
		const result = parseSitemap(
			`<sitemapindex>${block.repeat(50_010)}</sitemapindex>`,
		);
		assert(result.kind === "sitemapindex");
		assertEquals(result.sitemaps.length, 50_000);
	});

	await t.step("plain text", () => {
		const result = parseSitemap("https://a.test/x\n".repeat(50_010));
		assert(result.kind === "urlset");
		assertEquals(result.entries.length, 50_000);
	});
});

// ------------------------------------------------------------------------------------
// fuzz
// ------------------------------------------------------------------------------------

Deno.test("parseSitemap: garbage never throws", () => {
	const alphabet = [
		"<",
		">",
		"/",
		"url",
		"loc",
		"urlset",
		"sitemap",
		"sitemapindex",
		":",
		"?xml",
		"!--",
		"-->",
		"![CDATA[",
		"]]>",
		"&amp;",
		"&#",
		";",
		'"',
		"'",
		"=",
		" ",
		"\n",
		"\t",
		"https://a.test/x",
		" ",
		"\ud800",
		"﻿",
		"%",
		"#",
	];

	// deterministic: a failure has to be reproducible from the seed alone
	let seed = 0x5eed;
	const next = (n: number) => {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		return seed % n;
	};

	for (let i = 0; i < 2000; i++) {
		let input = "";
		const length = next(60);
		for (let k = 0; k < length; k++) input += alphabet[next(alphabet.length)];

		const result = parseSitemap(input);
		// not just "did not throw": the union must still be inhabited correctly
		if (result.kind === "urlset") {
			for (const entry of result.entries) assert(entry.url.length > 0, input);
		} else {
			for (const entry of result.sitemaps) assert(entry.url.length > 0, input);
		}
	}
});
