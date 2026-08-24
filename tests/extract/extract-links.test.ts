import { assert, assertEquals, assertFalse } from "@std/assert";
import {
	DEFAULT_EXTRACT_OPTIONS,
	extractBaseHref,
	extractLinks,
	extractTitle,
} from "../../src/extract/mod.ts";
import type { ExtractLinksOptions } from "../../src/extract/mod.ts";
import { resolveCrawlOptions } from "../../src/options.ts";

const BASE = "https://example.com/dir/page.html";

const hrefs = (html: string, opts?: ExtractLinksOptions) =>
	extractLinks(html, BASE, opts).map((l) => l.href);
const urls = (html: string, opts?: ExtractLinksOptions) =>
	extractLinks(html, BASE, opts).map((l) => l.url);
const regions = (html: string, opts?: ExtractLinksOptions) =>
	extractLinks(html, BASE, opts).map((l) => l.region);

Deno.test("extractLinks: anchors are the default source", async (t) => {
	await t.step("one anchor, fully described", () => {
		assertEquals(
			extractLinks(`<a href="/about">About us</a>`, BASE),
			[{
				href: "/about",
				tag: "a",
				rel: "page",
				nofollow: false,
				ugc: false,
				sponsored: false,
				anchorText: "About us",
				url: "https://example.com/about",
			}],
		);
	});

	await t.step("document order is preserved and occurrences are not deduped", () => {
		assertEquals(
			hrefs(`<a href="/b">b</a><a href="/a">a</a><a href="/b">b again</a>`),
			["/b", "/a", "/b"],
		);
	});

	await t.step("relative hrefs resolve against the page, not the origin", () => {
		assertEquals(urls(`<a href="x.html">x</a>`), [
			"https://example.com/dir/x.html",
		]);
		assertEquals(urls(`<a href="../y.html">y</a>`), ["https://example.com/y.html"]);
		assertEquals(urls(`<a href="//other.com/z">z</a>`), ["https://other.com/z"]);
	});

	await t.step("<area> counts, and carries no anchor text", () => {
		const [link] = extractLinks(`<map><area href="/hot"></map>`, BASE);
		assertEquals(link.tag, "area");
		assertEquals(link.rel, "page");
		assertEquals(link.anchorText, undefined);
	});

	await t.step("an empty or whitespace-only href is not a link", () => {
		assertEquals(hrefs(`<a href="">x</a><a href="   ">y</a><a>z</a>`), []);
	});

	await t.step("hrefs are trimmed, but otherwise verbatim", () => {
		assertEquals(hrefs(`<a href="  /x  ">x</a>`), ["/x"]);
	});

	await t.step("nothing is filtered — that is the crawl loop's job", () => {
		assertEquals(
			hrefs(
				`<a href="javascript:void(0)">j</a><a href="mailto:a@b.c">m</a>` +
					`<a href="#top">t</a><a href="https://elsewhere.org/">e</a>`,
			),
			["javascript:void(0)", "mailto:a@b.c", "#top", "https://elsewhere.org/"],
		);
	});

	await t.step("anchors can be turned off", () => {
		assertEquals(hrefs(`<a href="/x">x</a>`, { anchors: false }), []);
	});
});

Deno.test("extractLinks: rel tokens", async (t) => {
	await t.step("nofollow / ugc / sponsored are flags, not text", () => {
		const [link] = extractLinks(
			`<a href="/x" rel="NoFollow ugc sponsored noopener">x</a>`,
			BASE,
		);
		assert(link.nofollow && link.ugc && link.sponsored);
	});

	await t.step("comma-separated rel lists are tolerated", () => {
		const [link] = extractLinks(`<a href="/x" rel="nofollow,noopener">x</a>`, BASE);
		assert(link.nofollow);
	});

	await t.step("absent rel means all three are false", () => {
		const [link] = extractLinks(`<a href="/x">x</a>`, BASE);
		assertFalse(link.nofollow || link.ugc || link.sponsored);
	});
});

Deno.test("extractLinks: what is markup and what only looks like it", async (t) => {
	await t.step("hrefs inside <script> and <style> are strings, not links", () => {
		assertEquals(
			hrefs(
				`<script>const s = '<a href="/js">no</a>';</script>` +
					`<style>/* <a href="/css">no</a> */</style>` +
					`<a href="/yes">yes</a>`,
			),
			["/yes"],
		);
	});

	await t.step("case and attributes on the raw-text element do not fool it", () => {
		assertEquals(
			hrefs(
				`<SCRIPT type="text/javascript">x = "<a href='/no'>";</SCRIPT>` +
					`<a href="/yes">y</a>`,
			),
			["/yes"],
		);
	});

	await t.step("an unclosed <script> swallows the document, as in a browser", () => {
		assertEquals(hrefs(`<script>var a = "<a href='/no'>"; <a href="/no2">`), []);
	});

	await t.step("comments, CDATA, doctype and PIs are skipped", () => {
		assertEquals(
			hrefs(
				`<!doctype html><!-- <a href="/c">c</a> -->` +
					`<![CDATA[ <a href="/d">d</a> ]]><?php echo '<a href="/p">'; ?>` +
					`<a href="/ok">ok</a>`,
			),
			["/ok"],
		);
	});

	await t.step("an unterminated comment swallows the rest", () => {
		assertEquals(hrefs(`<!-- <a href="/x">x</a>`), []);
	});

	await t.step("<noscript> content IS markup — those links are real", () => {
		assertEquals(hrefs(`<noscript><a href="/plain">p</a></noscript>`), ["/plain"]);
	});

	await t.step("a script src is an asset, even though its body is skipped", () => {
		assertEquals(
			hrefs(`<script src="/app.js">x = 1;</script>`, { assets: true }),
			["/app.js"],
		);
	});
});

Deno.test("extractLinks: attribute soup", async (t) => {
	await t.step("first occurrence of an attribute wins", () => {
		assertEquals(hrefs(`<a href="/first" href="/second">x</a>`), ["/first"]);
	});

	await t.step("unquoted and single-quoted values both work", () => {
		assertEquals(hrefs(`<a href=/un>u</a><a href='/sq'>s</a>`), ["/un", "/sq"]);
	});

	await t.step("a > inside a quoted value does not end the tag", () => {
		assertEquals(hrefs(`<a href="/a>b" title="x>y">z</a>`), ["/a>b"]);
	});

	await t.step("a quote inside an unquoted value cannot swallow the document", () => {
		assertEquals(hrefs(`<a href=/a"b>x</a><a href="/after">after</a>`), [
			'/a"b',
			"/after",
		]);
	});

	await t.step("<a href=/> is an href of '/', not a self-closing tag", () => {
		assertEquals(hrefs(`<a href=/>x</a>`), ["/"]);
	});

	await t.step("whitespace around '=' is tolerated", () => {
		assertEquals(hrefs(`<a href = "/spaced" >x</a>`), ["/spaced"]);
	});

	await t.step("a tag unterminated at EOF still yields its href", () => {
		assertEquals(hrefs(`<a href="/eof"`), ["/eof"]);
		assertEquals(hrefs(`<a href="/unclosed-quote`), ["/unclosed-quote"]);
		assertEquals(hrefs(`<a href="`), []);
	});

	await t.step("a stray < is text", () => {
		assertEquals(hrefs(`a < b <3 </> <a href="/x">x</a>`), ["/x"]);
	});

	await t.step("unclosed tags do not derail the scan", () => {
		assertEquals(
			hrefs(`<div><p><a href="/one">one<a href="/two">two</div>`),
			["/one", "/two"],
		);
	});
});

Deno.test("extractLinks: entities", async (t) => {
	await t.step("&amp; in an href is one URL, not two", () => {
		assertEquals(urls(`<a href="/s?a=1&amp;b=2">s</a>`), [
			"https://example.com/s?a=1&b=2",
		]);
	});

	await t.step("numeric and hex references decode", () => {
		const [link] = extractLinks(`<a href="/x">&#65;&#x42;&amp;&nbsp;C</a>`, BASE);
		assertEquals(link.anchorText, "AB& C");
	});

	await t.step("an entity we do not know stays verbatim", () => {
		const [link] = extractLinks(`<a href="/x">a &hellip; b &notanentity;</a>`, BASE);
		assertEquals(link.anchorText, "a &hellip; b &notanentity;");
	});

	await t.step("a bare & is not an entity", () => {
		assertEquals(hrefs(`<a href="/a&b">x</a>`), ["/a&b"]);
	});

	await t.step("&constructor; does not reach a prototype", () => {
		const [link] = extractLinks(`<a href="/x">&constructor;</a>`, BASE);
		assertEquals(link.anchorText, "&constructor;");
	});

	await t.step("a NUL or surrogate reference is left alone", () => {
		const [link] = extractLinks(`<a href="/x">&#0;&#xD800;</a>`, BASE);
		assertEquals(link.anchorText, "&#0;&#xD800;");
	});
});

Deno.test("extractLinks: <base href>", async (t) => {
	await t.step("it governs links written before it, too", () => {
		assertEquals(
			urls(`<a href="a">a</a><base href="/sub/"><a href="b">b</a>`),
			["https://example.com/sub/a", "https://example.com/sub/b"],
		);
	});

	await t.step("the first <base href> wins", () => {
		assertEquals(
			urls(`<base href="/one/"><base href="/two/"><a href="x">x</a>`),
			["https://example.com/one/x"],
		);
	});

	await t.step("a <base> without href is not a base", () => {
		assertEquals(
			urls(`<base target="_blank"><base href="/sub/"><a href="x">x</a>`),
			["https://example.com/sub/x"],
		);
	});

	await t.step("an unresolvable <base href> falls back to the page URL", () => {
		assertEquals(urls(`<base href="http://"><a href="x">x</a>`), [
			"https://example.com/dir/x",
		]);
	});

	await t.step("detectBase: false ignores it — the narrowed-HTML case", () => {
		assertEquals(
			urls(`<base href="/sub/"><a href="x">x</a>`, { detectBase: false }),
			["https://example.com/dir/x"],
		);
	});

	await t.step("extractBaseHref answers the same question standalone", () => {
		assertEquals(
			extractBaseHref(`<html><head><base href="../up/">`, BASE),
			"https://example.com/up/",
		);
		assertEquals(extractBaseHref(`<html><head>`, BASE), BASE);
		assertEquals(extractBaseHref(`<base href="http://">`, BASE), BASE);
		assertEquals(extractBaseHref(``, BASE), BASE);
		assertEquals(extractBaseHref(`<base href="/x/">`, "not a url"), "not a url");
	});
});

Deno.test("extractLinks: anchor text", async (t) => {
	await t.step("nested markup is stripped, whitespace collapsed", () => {
		const [link] = extractLinks(
			`<a href="/x">  <b>Read</b>\n  <i>more</i>  </a>`,
			BASE,
		);
		assertEquals(link.anchorText, "Read more");
	});

	await t.step("a script inside the anchor is not text", () => {
		const [link] = extractLinks(
			`<a href="/x"><script>var t = "no";</script>yes</a>`,
			BASE,
		);
		assertEquals(link.anchorText, "yes");
	});

	await t.step("an image-only link has no text", () => {
		const [link] = extractLinks(`<a href="/x"><img src="/i.png"></a>`, BASE);
		assertEquals(link.anchorText, undefined);
	});

	await t.step("text is capped", () => {
		const [link] = extractLinks(
			`<a href="/x">${"ab".repeat(500)}</a>`,
			BASE,
			{ maxAnchorText: 10 },
		);
		assertEquals(link.anchorText, "ababababab");
	});

	await t.step("a cap of 0 means no anchor text at all", () => {
		const [link] = extractLinks(`<a href="/x">text</a>`, BASE, {
			maxAnchorText: 0,
		});
		assertEquals(link.anchorText, undefined);
	});

	await t.step("the cap never splits a surrogate pair", () => {
		const [link] = extractLinks(`<a href="/x">ab😀cd</a>`, BASE, {
			maxAnchorText: 3,
		});
		assertEquals(link.anchorText, "ab");
	});

	await t.step("a missing </a> stops at the window, not at the document end", () => {
		const [link] = extractLinks(`<a href="/x">start${"x".repeat(9000)}`, BASE, {
			maxAnchorText: Infinity,
		});
		assert(link.anchorText!.length < 9000);
	});
});

Deno.test("extractLinks: <meta http-equiv=refresh>", async (t) => {
	const url = (content: string) =>
		extractLinks(`<meta http-equiv="refresh" content="${content}">`, BASE)[0]
			?.href;

	await t.step("the documented spelling", () => {
		assertEquals(url("5; url=/next"), "/next");
	});

	await t.step("tolerated spellings", () => {
		assertEquals(url("0,/next"), "/next");
		assertEquals(url("5; URL='/next'"), "/next");
		assertEquals(url(`0; url=&quot;/next&quot;`), "/next");
		assertEquals(url("url=/next"), "/next");
		assertEquals(url("0;/next"), "/next");
	});

	await t.step("a delay without a URL is not a link", () => {
		assertEquals(url("5"), undefined);
		assertEquals(url(""), undefined);
		assertEquals(url("5;"), undefined);
	});

	await t.step("a URL containing a comma survives", () => {
		assertEquals(url("0; url=/a,b"), "/a,b");
	});

	await t.step(
		"http-equiv matching is case-insensitive; other metas are ignored",
		() => {
			assertEquals(
				hrefs(`<meta http-equiv="REFRESH" content="0; url=/a">`),
				["/a"],
			);
			assertEquals(hrefs(`<meta name="refresh" content="0; url=/a">`), []);
		},
	);

	await t.step("it is tagged as a page link from the meta element", () => {
		const [link] = extractLinks(
			`<meta http-equiv="refresh" content="0; url=/a">`,
			BASE,
		);
		assertEquals([link.tag, link.rel], ["meta", "page"]);
	});

	await t.step("metaRefresh: false turns it off", () => {
		assertEquals(
			hrefs(`<meta http-equiv="refresh" content="0; url=/a">`, {
				metaRefresh: false,
			}),
			[],
		);
	});
});

Deno.test("extractLinks: <link> classification", async (t) => {
	const rel = (tag: string, opts?: ExtractLinksOptions) =>
		extractLinks(tag, BASE, opts)[0]?.rel;

	await t.step("canonical and prev/next are on by default", () => {
		assertEquals(rel(`<link rel="canonical" href="/c">`), "canonical");
		assertEquals(rel(`<link rel="next" href="/n">`), "next");
		assertEquals(rel(`<link rel="prev" href="/p">`), "prev");
		assertEquals(rel(`<link rel="previous" href="/p">`), "prev");
	});

	await t.step("alternate and stylesheet are opt-in", () => {
		assertEquals(rel(`<link rel="alternate" href="/a" hreflang="sk">`), undefined);
		assertEquals(rel(`<link rel="stylesheet" href="/s.css">`), undefined);
		assertEquals(
			rel(`<link rel="alternate" href="/a" hreflang="sk">`, { alternate: true }),
			"alternate",
		);
		assertEquals(
			rel(`<link rel="stylesheet" href="/s.css">`, { assets: true }),
			"asset",
		);
	});

	await t.step("hreflang is recorded when present", () => {
		const [link] = extractLinks(
			`<link rel="alternate" hreflang="sk-SK" href="/sk">`,
			BASE,
			{ alternate: true },
		);
		assertEquals(link.hreflang, "sk-SK");
		const [feed] = extractLinks(
			`<link rel="alternate" type="application/rss+xml" href="/feed">`,
			BASE,
			{ alternate: true },
		);
		assertEquals(feed.hreflang, undefined);
	});

	await t.step("a rel='alternate stylesheet' is a stylesheet", () => {
		assertEquals(
			rel(`<link rel="alternate stylesheet" href="/s.css">`, {
				alternate: true,
				assets: true,
			}),
			"asset",
		);
	});

	await t.step("one <link> is one edge, canonical first", () => {
		assertEquals(
			extractLinks(`<link rel="canonical next" href="/c">`, BASE).length,
			1,
		);
	});

	await t.step("a <link> with no rel we know is not a link", () => {
		assertEquals(hrefs(`<link rel="preload" href="/x"><link href="/y">`), []);
	});

	await t.step("nextPrev / canonical can be turned off", () => {
		assertEquals(
			hrefs(`<link rel="canonical" href="/c"><link rel="next" href="/n">`, {
				canonical: false,
				nextPrev: false,
			}),
			[],
		);
	});
});

Deno.test("extractLinks: assets, srcset and frames", async (t) => {
	const HTML = `<img src="/i.png" srcset="/a.png 1x, /b.png 2x">` +
		`<script src="/app.js"></script>` +
		`<video src="/v.mp4" poster="/p.jpg"><source src="/v.webm" srcset="/s.webm 2x">` +
		`</video><audio src="/a.mp3"></audio><iframe src="/frame"></iframe>` +
		`<frame src="/old">`;

	await t.step("all off by default", () => {
		assertEquals(hrefs(HTML), []);
	});

	await t.step("assets: true takes src and poster", () => {
		assertEquals(hrefs(HTML, { assets: true }), [
			"/i.png",
			"/app.js",
			"/v.mp4",
			"/p.jpg",
			"/v.webm",
			"/a.mp3",
		]);
	});

	await t.step("srcset is separate from assets", () => {
		assertEquals(hrefs(HTML, { srcset: true }), ["/a.png", "/b.png", "/s.webm"]);
	});

	await t.step("a srcset candidate keeps only its URL", () => {
		assertEquals(
			hrefs(`<img srcset="  /w.png   500w  ,  /x.png">`, { srcset: true }),
			["/w.png", "/x.png"],
		);
	});

	await t.step("iframes: true takes iframe and frame", () => {
		assertEquals(hrefs(HTML, { iframes: true }), ["/frame", "/old"]);
		const [link] = extractLinks(`<iframe src="/f"></iframe>`, BASE, {
			iframes: true,
		});
		assertEquals([link.tag, link.rel], ["iframe", "iframe"]);
	});
});

Deno.test("extractLinks: regions", async (t) => {
	const HTML = `<header><a href="/h">h</a></header>` +
		`<nav><a href="/n">n</a></nav>` +
		`<main><a href="/m">m</a>` +
		`<article><a href="/art">art</a>` +
		`<header><a href="/byline">byline</a></header></article>` +
		`<nav><a href="/toc">toc</a></nav></main>` +
		`<aside><a href="/side">side</a></aside>` +
		`<footer><a href="/f">f</a></footer>` +
		`<div><a href="/plain">plain</a></div>`;

	await t.step("every landmark is reported, innermost wins", () => {
		assertEquals(regions(HTML), [
			"header",
			"nav",
			"main",
			"article",
			"header",
			"nav",
			"aside",
			"footer",
			undefined,
		]);
	});

	await t.step("a document with no landmarks reports nothing", () => {
		assertEquals(
			regions(
				`<div><p><a href="/a">a</a></p></div><span><a href="/b">b</a></span>`,
			),
			[undefined, undefined],
		);
	});

	await t.step("an unclosed landmark ends with its parent", () => {
		assertEquals(
			regions(`<main><nav><a href="/in">in</a></main><a href="/out">out</a>`),
			["nav", undefined],
		);
	});

	await t.step("a close with no open is ignored", () => {
		assertEquals(regions(`</nav><a href="/x">x</a>`), [undefined]);
	});

	await t.step("pathological nesting does not grow without bound", () => {
		const deep = "<main>".repeat(5000) + `<a href="/x">x</a>`;
		assertEquals(regions(deep), ["main"]);
	});

	await t.step("a landmark is never itself a link source", () => {
		assertEquals(hrefs(`<nav href="/weird"><a href="/x">x</a></nav>`), ["/x"]);
	});
});

Deno.test("extractLinks: the landmark stack is depth-capped", async (t) => {
	// Six landmark elements nested 64 deep is not a document, it is an attempt to grow
	// our stack. Past the cap the innermost-wins rule degrades rather than the memory —
	// and that degradation is observable, which is what makes the cap testable at all.
	const nest = (depth: number, innermost: string) =>
		"<main>".repeat(depth) + `<${innermost}><a href="/x">t</a>`;

	await t.step("the 64th landmark still counts", () => {
		assertEquals(regions(nest(63, "nav")), ["nav"]);
	});

	await t.step("the 65th does not — the link keeps the 64th", () => {
		assertEquals(regions(nest(64, "nav")), ["main"]);
		assertEquals(regions(nest(5_000, "nav")), ["main"]);
	});

	await t.step("closing back below the cap makes room again", () => {
		// the stack is not permanently poisoned: pop one and the next open lands
		assertEquals(
			regions("<main>".repeat(64) + "</main>" + `<nav><a href="/x">t</a>`),
			["nav"],
		);
	});
});

Deno.test("extractLinks: caps and bad input", async (t) => {
	await t.step("maxLinks drops the tail", () => {
		const html = Array.from({ length: 10 }, (_, i) => `<a href="/${i}">x</a>`)
			.join("");
		assertEquals(hrefs(html, { maxLinks: 3 }), ["/0", "/1", "/2"]);
	});

	await t.step("maxLinks is exact even when one tag makes several links", () => {
		const html = `<img srcset="/a 1x, /b 2x, /c 3x, /d 4x">`;
		assertEquals(hrefs(html, { srcset: true, maxLinks: 2 }), ["/a", "/b"]);
	});

	await t.step("a nonsensical option falls back to its default, never throws", () => {
		assertEquals(hrefs(`<a href="/x">x</a>`, { maxLinks: 0 }), ["/x"]);
		assertEquals(
			hrefs(`<a href="/x">x</a>`, { maxLinks: NaN, maxAnchorText: -1 }),
			["/x"],
		);
	});

	await t.step("a fractional cap is floored, not handed to `length`", () => {
		// `links.length = 0.5` is a RangeError, so a cap below 1 has to fall back to
		// the default like any other out-of-range value (found by the fuzz suite)
		assertEquals(hrefs(`<a href="/a">a</a><a href="/b">b</a>`, { maxLinks: 0.5 }), [
			"/a",
			"/b",
		]);
		assertEquals(hrefs(`<a href="/a">a</a><a href="/b">b</a>`, { maxLinks: 1.9 }), [
			"/a",
		]);
		// `slice` tolerates a fraction, so this half only discriminates through the
		// cap assertion the fuzz suite makes; it is here because "the cap is a whole
		// number" is the rule, and 2.7 must mean 2 rather than "somewhere near 3"
		const [link] = extractLinks(`<a href="/a">hello</a>`, BASE, {
			maxAnchorText: 2.7,
		});
		assertEquals(link.anchorText, "he");
	});

	await t.step("a page of unclosed anchors stays linear in the document", () => {
		// `findCloseTagIndex` used to search with `indexOf("</", k)`, which takes no
		// end argument: it scanned to the end of the DOCUMENT and let `limit` reject
		// the answer afterwards. Since anchor text is looked up once per `<a>`, a page
		// whose anchors are never closed cost O(links x document) — 47s of blocked
		// event loop on 1.3 MB of markup, against 12ms for the same page closed.
		// The window cap now bounds the scan, so growing the document must not move
		// the number.
		const timeFor = (tailBytes: number) => {
			const doc = '<a href="/x">t'.repeat(2_000) + "<b>".repeat(tailBytes / 3 | 0);
			let best = Infinity;
			for (let run = 0; run < 2; run++) {
				const started = performance.now();
				assertEquals(extractLinks(doc, BASE).length, 2_000);
				best = Math.min(best, performance.now() - started);
			}
			return best;
		};
		const small = timeFor(20_000);
		const large = timeFor(600_000);
		// the tail carries no links and no `</`, so it is pure document length:
		// bounded scanning is flat in it, the old unbounded one was ~20x
		assert(
			large < 3 * Math.max(small, 1),
			`a 48 KB page took ${small.toFixed(0)}ms and a 628 KB one ` +
				`${large.toFixed(0)}ms — the close-tag search is unbounded again`,
		);
	});

	await t.step("a close tag only closes an element of exactly that name", () => {
		// the boundary check inside findCloseTagIndex: "</abbr>" must not end "<a>",
		// or every anchor followed by an abbreviation loses its text
		assertEquals(
			extractLinks(`<a href="/x">see <abbr>HTML</abbr> here</a>`, BASE)[0]
				.anchorText,
			"see HTML here",
		);
		// `</abbr>` does not end the anchor, so the text runs past it (and the tag
		// itself is stripped as markup, as any tag inside an anchor is)
		assertEquals(
			extractLinks(`<a href="/x">text</abbr>`, BASE)[0].anchorText,
			"text",
		);
		// and a name that merely starts the same is not a match either way round
		assertEquals(
			extractTitle(`<title>keep <titlecase>this</titlecase></title>`),
			"keep this",
		);
	});

	await t.step("a run of bare ampersands stays linear", () => {
		// The `;` search used to run to the end of the document for every `&` that was
		// not an entity — quadratic, on a query string any site can serve. Measured as
		// a growth rate rather than a wall-clock ceiling: the broken version took only
		// ~0.9 s at 200k, which passes any budget loose enough not to be flaky.
		const timeFor = (n: number) => {
			const html = `<a href="/x?${"&".repeat(n)}">x</a>`;
			let best = Infinity;
			for (let run = 0; run < 3; run++) {
				const started = performance.now();
				assertEquals(hrefs(html)[0].length, n + 3);
				best = Math.min(best, performance.now() - started);
			}
			return best;
		};
		const small = timeFor(100_000);
		const large = timeFor(400_000);
		// 4x the input: linear is ~4x, the old quadratic measured ~18x
		assert(
			large < 8 * Math.max(small, 1),
			`100k took ${small.toFixed(1)}ms but 400k took ${large.toFixed(1)}ms — ` +
				`the entity scan is unbounded again`,
		);
	});

	await t.step("an href no parser can resolve has no url", () => {
		const [link] = extractLinks(`<a href="http://">x</a>`, BASE);
		assertEquals([link.href, link.url], ["http://", undefined]);
	});

	await t.step("an unusable base leaves every url undefined", () => {
		const links = extractLinks(`<a href="/x">x</a>`, "not a url");
		assertEquals(links.length, 1);
		assertEquals(links[0].url, undefined);
	});

	await t.step("an absolute <base href> rescues an unusable page URL", () => {
		const [link] = extractLinks(
			`<base href="https://cdn.example.com/"><a href="x">x</a>`,
			"not a url",
		);
		assertEquals(link.url, "https://cdn.example.com/x");
	});

	await t.step("garbage in, empty out — never an exception", () => {
		const garbage = [
			"",
			"<",
			"<<<<",
			"<a",
			"<a href=",
			'<a href="',
			"</",
			"<!--",
			"<![CDATA[",
			"<?",
			"\u0000�<a href=/x>",
			"<a href=/x>".repeat(1000),
		];
		for (const html of garbage) {
			assert(Array.isArray(extractLinks(html, BASE)), html);
			assert(Array.isArray(extractLinks(html, "")), html);
		}
		// deno-lint-ignore no-explicit-any
		assertEquals(extractLinks(null as any, BASE), []);
		// deno-lint-ignore no-explicit-any
		assertEquals(extractLinks(123 as any, BASE), []);
	});
});

Deno.test("extractTitle", async (t) => {
	await t.step("decodes, collapses and trims", () => {
		assertEquals(
			extractTitle(`<html><head><title>  Hello &amp;\n  World  </title>`),
			"Hello & World",
		);
	});

	await t.step("the first title wins", () => {
		assertEquals(extractTitle(`<title>one</title><title>two</title>`), "one");
	});

	await t.step("an <svg><title> is a label, not a document title", () => {
		assertEquals(
			extractTitle(`<svg><title>icon</title></svg><title>real</title>`),
			"real",
		);
		assertEquals(extractTitle(`<svg><title>icon</title></svg>`), undefined);
	});

	await t.step("no title, or an empty one, is undefined", () => {
		assertEquals(extractTitle(`<html><body>no title here`), undefined);
		assertEquals(extractTitle(`<title></title>`), undefined);
		assertEquals(extractTitle(`<title>   </title>`), undefined);
		assertEquals(extractTitle(``), undefined);
	});

	await t.step("it is capped", () => {
		assertEquals(extractTitle(`<title>${"x".repeat(1000)}</title>`)?.length, 512);
		assertEquals(extractTitle(`<title>abcdef</title>`, { maxLength: 3 }), "abc");
	});

	await t.step("markup inside the title is stripped", () => {
		assertEquals(extractTitle(`<title>a <b>b</b> c</title>`), "a b c");
	});

	await t.step("a comment before the title does not hide it", () => {
		assertEquals(
			extractTitle(`<!-- <title>fake</title> --><title>real</title>`),
			"real",
		);
	});

	await t.step("an unclosed title stops at the window", () => {
		const title = extractTitle(`<title>${"x".repeat(9000)}`, {
			maxLength: Infinity,
		});
		assert(title!.length < 9000);
	});

	await t.step("never throws", () => {
		// deno-lint-ignore no-explicit-any
		assertEquals(extractTitle(null as any), undefined);
		assertEquals(extractTitle(`<title>`), undefined);
	});
});

Deno.test("DEFAULT_EXTRACT_OPTIONS — the crawler and the standalone call agree", () => {
	assertEquals({ ...DEFAULT_EXTRACT_OPTIONS }, resolveCrawlOptions().extract);
});
