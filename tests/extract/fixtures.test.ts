import { assert, assertEquals, assertFalse } from "@std/assert";
import {
	DEFAULT_EXTRACT_OPTIONS,
	extractBaseHref,
	extractLinks,
	extractTitle,
	parseRobotsTxt,
} from "../../src/extract/mod.ts";
import type { ExtractLinksOptions } from "../../src/extract/mod.ts";
import { listFixtures, readFixture } from "../_fixtures.ts";

/**
 * The `./extract` fixture corpus.
 *
 * Each file under `tests/fixtures/` encodes exactly one pathology, and the step that
 * reads it says what the extractor is expected to make of it. That division is the
 * point: the inline suites next door pin *behaviors* one construct at a time, while
 * these pin whole documents — the interactions that only show up when a `<base>`, a
 * `<script>` and an unclosed `<nav>` are on the same page.
 *
 * Fixtures are small and synthetic-but-nasty rather than vendored real pages (no
 * license noise, no churn), and the one document that needs to be large is generated
 * here at setup rather than committed.
 */

const BASE = "https://example.com/dir/page.html";

const html = (name: string) => readFixture("html", name);
const robots = (name: string) => readFixture("robots", name);

const hrefs = (name: string, opts?: ExtractLinksOptions) =>
	extractLinks(html(name), BASE, opts).map((link) => link.href);
const regions = (name: string, opts?: ExtractLinksOptions) =>
	extractLinks(html(name), BASE, opts).map((link) => link.region);

// ------------------------------------------------------------------------------------
// html
// ------------------------------------------------------------------------------------

Deno.test("fixture html/basic.html — a clean document", async (t) => {
	await t.step("the title is decoded, collapsed and trimmed", () => {
		assertEquals(extractTitle(html("basic.html")), "Basic fixture page");
	});

	await t.step("with no <base>, the effective base is the page itself", () => {
		assertEquals(extractBaseHref(html("basic.html"), BASE), BASE);
	});

	await t.step("the default sources, in document order", () => {
		// canonical/next/prev come from <head> and so precede every anchor;
		// rel=alternate and rel=stylesheet are off by default, <meta name=robots>
		// is not a link at all
		assertEquals(hrefs("basic.html"), [
			"https://example.com/dir/page.html",
			"page2.html",
			"/index.html",
			"/about",
			"../up.html",
			"https://elsewhere.org/",
			"#top",
			"mailto:a@b.c",
		]);
	});

	await t.step("an empty href and a missing href are not links", () => {
		assert(!hrefs("basic.html").includes(""));
	});

	await t.step("nothing is filtered — off-site, fragment and mailto all land", () => {
		const links = extractLinks(html("basic.html"), BASE);
		const off = links.find((l) => l.href === "https://elsewhere.org/")!;
		assertEquals(off.nofollow, true);
		assertEquals(links.find((l) => l.href === "#top")?.url, `${BASE}#top`);
		assertEquals(links.find((l) => l.href === "mailto:a@b.c")?.url, "mailto:a@b.c");
	});

	await t.step("<head> links carry no region, <main> links do", () => {
		assertEquals(regions("basic.html"), [
			undefined,
			undefined,
			undefined,
			"main",
			"main",
			"main",
			"main",
			"main",
		]);
	});
});

Deno.test("fixture html/script-noise.html — only real markup is a link", async (t) => {
	await t.step("script, style, comment, CDATA and textarea contribute nothing", () => {
		// the tokenizer-skip proof: every "/from-*" href in this document sits
		// somewhere a browser would never treat as markup
		assertEquals(hrefs("script-noise.html"), [
			"/real-1",
			"/from-noscript",
			"/real-2",
		]);
	});

	await t.step("<noscript> is the deliberate exception", () => {
		// its content IS markup for a client without scripting, which is what a
		// crawler is
		assert(hrefs("script-noise.html").includes("/from-noscript"));
	});

	await t.step("a `>` inside script arithmetic does not end the raw-text skip", () => {
		// `if (a < b && c > d)` sits inside the <script>. The title assertion this
		// step used to make proved nothing — `<title>` precedes the `<script>`, so
		// extractTitle returns before it ever gets there. What actually depends on
		// the skip is the link list: if it ended at that `>`, the assignment right
		// after it would be scanned as markup.
		const links = hrefs("script-noise.html");
		assertFalse(links.some((href) => href.includes("from-script")));
		// and the scan really did resume afterwards, or /real-2 would be missing
		assertEquals(links.at(-1), "/real-2");
	});

	await t.step("the title is read from <head>, before any of that", () => {
		assertEquals(extractTitle(html("script-noise.html")), "script noise");
	});
});

Deno.test("fixture html/messy-unclosed.html — attribute soup", async (t) => {
	await t.step("every malformed anchor still yields its href", () => {
		assertEquals(hrefs("messy-unclosed.html"), [
			"/unquoted",
			"/single",
			"/UPPER",
			"/first", // a duplicate attribute: the first one wins
			"/gt>inside", // a quoted ">" does not end the tag
			'a"b', // a quote where no value can start is part of the value
			"/", // `<a href=/>` is an href of "/", not a self-closing tag
			"/spaced",
			"/dup-in-soup",
			"/unclosed-parents",
			"/at-eof", // an unterminated tag at EOF is still reported
		]);
	});

	await t.step("hrefs keep their case; only tag and attribute names fold", () => {
		assert(hrefs("messy-unclosed.html").includes("/UPPER"));
	});

	await t.step("the tag that runs into EOF has no anchor text to find", () => {
		const last = extractLinks(html("messy-unclosed.html"), BASE).at(-1)!;
		assertEquals(last.href, "/at-eof");
		assertEquals(last.anchorText, undefined);
	});

	await t.step("a document with no <title> reports none", () => {
		assertEquals(extractTitle(html("messy-unclosed.html")), undefined);
	});
});

Deno.test("fixture html/base-href.html — <base> governs the whole document", async (t) => {
	await t.step("<base target> is not a base href; the first <base href> wins", () => {
		assertEquals(
			extractBaseHref(html("base-href.html"), BASE),
			"https://example.com/base/",
		);
	});

	await t.step("links written BEFORE the base still resolve against it", () => {
		// the <link rel=canonical> sits after <base> in this fixture, but a browser
		// applies the base to the whole document either way — the canonical is the
		// cheapest way to see that extractLinks resolves in a second pass
		const links = extractLinks(html("base-href.html"), BASE);
		assertEquals(links[0].rel, "canonical");
		assertEquals(links[0].url, "https://example.com/base/c.html");
	});

	await t.step(
		"relative, root-relative and absolute hrefs each resolve correctly",
		() => {
			const byHref = new Map(
				extractLinks(html("base-href.html"), BASE).map((l) => [l.href, l.url]),
			);
			assertEquals(byHref.get("rel.html"), "https://example.com/base/rel.html");
			assertEquals(byHref.get("/abs.html"), "https://example.com/abs.html");
			assertEquals(byHref.get("https://other.org/x"), "https://other.org/x");
			// a later <base> never displaces the first one
			assertEquals(byHref.get("after.html"), "https://example.com/base/after.html");
		},
	);

	await t.step("detectBase:false ignores the document's base entirely", () => {
		// what the engine does for the body pass of a `beforeExtract` crawl
		const byHref = new Map(
			extractLinks(html("base-href.html"), BASE, { detectBase: false })
				.map((l) => [l.href, l.url]),
		);
		assertEquals(byHref.get("rel.html"), "https://example.com/dir/rel.html");
	});
});

Deno.test("fixture html/entities.html — decoding", async (t) => {
	await t.step("an &amp; in an href is a different URL, so it is decoded", () => {
		assertEquals(hrefs("entities.html"), [
			"/search?q=a&b=2",
			"/n?x=1&y=2",
			"/h?x=1&y=2",
			"/t",
			"/nb",
			"/unknown",
			"/bad",
		]);
	});

	await t.step("anchor text decodes the names we know and keeps the rest", () => {
		const text = new Map(
			extractLinks(html("entities.html"), BASE).map((l) => [l.href, l.anchorText]),
		);
		assertEquals(text.get("/t"), `Tom & Jerry <3 "quotes" 'apostrophes'`);
		// &nbsp; decodes to U+00A0, which then collapses like any other whitespace
		assertEquals(text.get("/nb"), "non breaking spaces");
		// an unknown name is cosmetic; `&constructor;` must not reach a prototype
		assertEquals(
			text.get("/unknown"),
			"&hellip; stays verbatim, and so does &constructor;",
		);
		// NUL, a lone surrogate, an out-of-range code point, a missing semicolon
		assertEquals(
			text.get("/bad"),
			"&#0; &#xD800; &#999999999; &notanentity &#; &amp",
		);
	});

	await t.step("the title decodes numerics and keeps unknown names", () => {
		assertEquals(extractTitle(html("entities.html")), "Caf&eacute; & Bar — entities");
	});
});

Deno.test("fixture html/meta-refresh.html — the tolerated spellings", async (t) => {
	await t.step("delay+url, comma form, quoted url and the delay-less form", () => {
		assertEquals(hrefs("meta-refresh.html"), [
			"/next",
			"/comma-separated",
			"/quoted",
			"/no-delay",
		]);
	});

	await t.step(
		"a bare delay, an empty content and a wrong attribute yield nothing",
		() => {
			// `content="5"`, `content=""`, no content at all, `name=refresh` (not
			// http-equiv) and an unrelated http-equiv are all in the fixture
			assertEquals(hrefs("meta-refresh.html").length, 4);
		},
	);

	await t.step("metaRefresh can be turned off", () => {
		assertEquals(hrefs("meta-refresh.html", { metaRefresh: false }), []);
	});
});

Deno.test("fixture html/srcset.html — candidate splitting", async (t) => {
	await t.step("every candidate is an occurrence, descriptors dropped", () => {
		assertEquals(hrefs("srcset.html", { assets: true, srcset: true }), [
			"/img/hero.jpg",
			"/img/hero-1x.jpg",
			"/img/hero-2x.jpg",
			"/img/a.png",
			"/img/b.png",
			"/img/c.png",
			"/img/wide.webp",
			"/img/fallback.jpg",
			"/img/fallback-2x.jpg",
			// the documented mis-split: a data: URI contains the separator
			"data:image/gif;base64",
			"R0lGODlhAQABAAAAACw=",
		]);
	});

	await t.step("src and srcset are independently switchable", () => {
		assertEquals(hrefs("srcset.html", { srcset: true }), [
			"/img/hero-1x.jpg",
			"/img/hero-2x.jpg",
			"/img/a.png",
			"/img/b.png",
			"/img/c.png",
			"/img/wide.webp",
			"/img/fallback-2x.jpg",
			"data:image/gif;base64",
			"R0lGODlhAQABAAAAACw=",
		]);
		assertEquals(hrefs("srcset.html"), []);
	});

	await t.step("empty and whitespace-only values contribute nothing", () => {
		// the fixture's last three tags carry `src=""`, `srcset=""` and
		// `srcset="   "`; between them they must add exactly the two data-URI
		// candidates and nothing else
		assertEquals(hrefs("srcset.html", { assets: true, srcset: true }).length, 11);
	});
});

Deno.test("fixture html/assets.html — what each toggle turns on", async (t) => {
	await t.step("by default only the page link", () => {
		assertEquals(hrefs("assets.html"), ["/page"]);
	});

	await t.step("assets:true adds stylesheets and media, never rel=icon", () => {
		const links = extractLinks(html("assets.html"), BASE, { assets: true });
		assertEquals(links.map((l) => l.href), [
			"/css/site.css",
			"/css/print.css", // rel="alternate stylesheet" IS a stylesheet
			"/img/logo.png",
			"/js/app.js",
			"/media/clip.mp4",
			"/media/poster.jpg", // a <video poster> is an asset too
			"/media/track.mp3",
			"/media/alt.webm",
			"/page",
		]);
		assert(!links.some((l) => l.href === "/favicon.ico"));
		assertEquals(
			links.filter((l) => l.href !== "/page").every((l) => l.rel === "asset"),
			true,
		);
	});

	await t.step("iframes:true adds <iframe> and <frame>, both rel iframe", () => {
		const links = extractLinks(html("assets.html"), BASE, { iframes: true });
		assertEquals(links.map((l) => [l.tag, l.rel, l.href]), [
			["iframe", "iframe", "/embed/1"],
			["frame", "iframe", "/frames/left.html"],
			["a", "page", "/page"],
		]);
	});

	await t.step("alternate:true records hreflang and excludes stylesheets", () => {
		const links = extractLinks(html("assets.html"), BASE, { alternate: true });
		assertEquals(links.map((l) => [l.rel, l.href, l.hreflang]), [
			["alternate", "/de/", "de"],
			["page", "/page", undefined],
		]);
	});
});

Deno.test("fixture html/anchor-text.html — what counts as text", async (t) => {
	const links = extractLinks(html("anchor-text.html"), BASE);

	await t.step("every anchor, in order, with the text it yields", () => {
		// exact and ordered, so an anchor that stops being extracted fails here
		// rather than quietly reading back as "no text"
		assertEquals(links.map((l) => [l.href, l.anchorText]), [
			// whitespace collapsed and trimmed
			["/a1", "lots of whitespace"],
			// nested markup stripped, its text kept
			["/a2", "nested markup is still text"],
			// an image-only anchor has no text
			["/a3", undefined],
			// and neither has an empty one
			["/a4", undefined],
			// entities are decoded
			["/a5", "Tom & Jerry"],
			// a <script> inside an anchor is not its text
			["/a6", "beforeafter"],
			// an unclosed anchor takes text up to the search window
			["/a7", "an unclosed anchor runs on past the next tag"],
		]);
	});

	await t.step("the textless anchors are extracted, not missing", () => {
		assertEquals(links.filter((l) => l.anchorText === undefined).map((l) => l.href), [
			"/a3",
			"/a4",
		]);
	});

	await t.step("maxAnchorText:0 turns text collection off entirely", () => {
		const off = extractLinks(html("anchor-text.html"), BASE, { maxAnchorText: 0 });
		assertEquals(off.length, links.length);
		assertEquals(off.every((l) => l.anchorText === undefined), true);
	});
});

Deno.test("fixture html/landmarks.html — innermost landmark wins", async (t) => {
	const links = extractLinks(html("landmarks.html"), BASE);

	await t.step("every link, in order, with the region it sits in", () => {
		// an exact ordered list rather than per-href lookups: `map.get(href)` returns
		// undefined for a MISSING link too, so a lookup-based check on the regionless
		// link would pass if that link silently stopped being extracted at all
		assertEquals(links.map((l) => [l.href, l.region]), [
			["/site-header", "header"],
			["/top-nav", "nav"],
			["/main-direct", "main"],
			// a <nav> inside <main> is nav — the docs-sidebar case that
			// outermost-wins would call "main" and crawl in full
			["/main-nav", "nav"],
			// an <article><header> byline is header: the deliberate cost
			["/article-header", "header"],
			// <main><article><p> is article, which is why the documented value
			// of followRegions is ["main", "article"] and not ["main"]
			["/article-body", "article"],
			["/main-aside", "aside"],
			["/page-aside", "aside"],
			["/site-footer", "footer"],
			// no landmark at all
			["/plain-div", undefined],
			// an unclosed landmark keeps applying; it does not corrupt the stack
			["/unclosed-nav", "nav"],
			["/after-unclosed-nav", "nav"],
		]);
	});

	await t.step("the regionless link really is extracted, not merely absent", () => {
		const plain = links.filter((l) => l.href === "/plain-div");
		assertEquals(plain.length, 1);
		assertFalse("region" in plain[0]);
	});

	await t.step("landmark elements are structure, never link sources", () => {
		assertEquals(new Set(links.map((l) => l.tag)), new Set(["a"]));
	});
});

Deno.test("fixture html/no-landmarks.html — div soup has no regions", async (t) => {
	await t.step("every link reports region undefined", () => {
		assertEquals(
			extractLinks(html("no-landmarks.html"), BASE).map((l) => [l.href, l.region]),
			[
				["/soup-header", undefined],
				["/soup-nav", undefined],
				["/soup-article", undefined],
				["/soup-footer", undefined],
			],
		);
	});

	await t.step("this is the document doc 02's whole-document fallback fires on", () => {
		const links = extractLinks(html("no-landmarks.html"), BASE);
		assert(links.length > 0);
		assertEquals(links.every((l) => !l.region), true);
	});
});

Deno.test("fixture html/giant — generated, not committed", async (t) => {
	// > 100 KB of markup: committing it would be churn for no gain, and generating it
	// keeps the pathology (link count) adjustable from one constant
	const LINKS = 20_000;
	const giantOf = (n: number) =>
		`<!DOCTYPE html><html><head><title>giant</title></head><body><main>` +
		Array.from(
			{ length: n },
			(_, i) => `<p><a href="/p/${i}" rel="nofollow">link number ${i}</a></p>`,
		).join("\n") +
		`</main></body></html>`;
	const giant = giantOf(LINKS);

	await t.step("the fixture really is large", () => {
		assert(giant.length > 100_000, `only ${giant.length} bytes`);
	});

	await t.step("maxLinks caps the result and drops the tail", () => {
		const links = extractLinks(giant, BASE, { maxLinks: 100 });
		assertEquals(links.length, 100);
		assertEquals(links[0].href, "/p/0");
		assertEquals(links[99].href, "/p/99");
	});

	await t.step("the default cap is what a 20k-link page actually meets", () => {
		const links = extractLinks(giant, BASE);
		assertEquals(links.length, DEFAULT_EXTRACT_OPTIONS.maxLinks);
		assertEquals(links.at(-1)!.href, `/p/${DEFAULT_EXTRACT_OPTIONS.maxLinks - 1}`);
	});

	await t.step("everything survives the trip, not just the count", () => {
		const links = extractLinks(giant, BASE);
		assertEquals(links[0], {
			href: "/p/0",
			tag: "a",
			rel: "page",
			nofollow: true,
			ugc: false,
			sponsored: false,
			region: "main",
			anchorText: "link number 0",
			url: "https://example.com/p/0",
		});
	});

	await t.step("runtime grows linearly with the document", () => {
		// a growth RATE, not a wall-clock ceiling: an absolute budget at one input
		// size measures the machine, and this package has already shipped two
		// super-linear scans that a smoke test that shape would have waved through.
		// `maxLinks: Infinity` because the default cap stops the scan a third of the
		// way in, which would hide exactly the growth we are measuring.
		const timeFor = (n: number) => {
			const doc = giantOf(n);
			let best = Infinity;
			for (let run = 0; run < 3; run++) {
				const started = performance.now();
				extractLinks(doc, BASE, { maxLinks: Infinity });
				best = Math.min(best, performance.now() - started);
			}
			return best;
		};
		const small = timeFor(LINKS / 8);
		const large = timeFor(LINKS);
		// 8x the document: linear is ~8x, quadratic is ~64x
		assert(
			large < 24 * Math.max(small, 1),
			`${(LINKS / 8)} links took ${small.toFixed(1)}ms but ${LINKS} took ` +
				`${large.toFixed(1)}ms — the scanner is not linear`,
		);
	});
});

// ------------------------------------------------------------------------------------
// robots
// ------------------------------------------------------------------------------------

Deno.test("fixture robots/basic.txt — the shape of a well-formed file", async (t) => {
	const parsed = parseRobotsTxt(robots("basic.txt"));

	await t.step("one implicit-star group with three rules", () => {
		assertEquals(parsed.groups.length, 1);
		assertEquals(parsed.groups[0].userAgents, ["*"]);
		assertEquals(parsed.groups[0].rules.length, 3);
	});

	await t.step("Sitemap lines are global and kept verbatim", () => {
		assertEquals(parsed.sitemaps, [
			"https://example.com/sitemap.xml",
			"https://example.com/sitemap-news.xml",
		]);
	});

	await t.step("longest match wins, so the Allow carves out of the Disallow", () => {
		assertEquals(parsed.isAllowed("/admin/x", "mybot"), false);
		assertEquals(parsed.isAllowed("/admin/public/x", "mybot"), true);
		assertEquals(parsed.isAllowed("/anything-else", "mybot"), true);
	});
});

Deno.test("fixture robots/wildcards.txt — * and $", async (t) => {
	const parsed = parseRobotsTxt(robots("wildcards.txt"));
	const allowed = (path: string) => parsed.isAllowed(path, "mybot");

	await t.step("a trailing $ anchors the pattern to the end of the path", () => {
		assertEquals(allowed("/a.pdf"), false);
		// the path does not END in .pdf once the query is part of it
		assertEquals(allowed("/docs/a.pdf?x=1"), true);
	});

	await t.step("`/$` disallows exactly the root", () => {
		assertEquals(allowed("/"), false);
		assertEquals(allowed("/x"), true);
	});

	await t.step("a * matches any run, including none", () => {
		assertEquals(allowed("/search?q=1"), false);
		assertEquals(allowed("/searching"), true); // "/search?*" needs the "?"
		assertEquals(allowed("/a/x/b"), false);
		assertEquals(allowed("/a/x/bc"), false); // unanchored: a prefix match
	});

	await t.step("a longer Allow beats a wildcard Disallow", () => {
		assertEquals(allowed("/a/keep/b"), true);
	});
});

Deno.test("fixture robots/groups.txt — grouping and agent selection", async (t) => {
	const parsed = parseRobotsTxt(robots("groups.txt"));

	await t.step("consecutive User-agent lines open ONE group", () => {
		assertEquals(parsed.groups[0].userAgents, ["badbot", "otherbot"]);
		assertEquals(parsed.isAllowed("/x", "badbot"), false);
		assertEquals(parsed.isAllowed("/x", "otherbot"), false);
	});

	await t.step("a non-rule directive between them does not split the group", () => {
		// `Host:` is ignored, so alpha and beta share one group
		assertEquals(parsed.groups[1].userAgents, ["alpha", "beta"]);
		assertEquals(parsed.isAllowed("/shared/x", "alpha"), false);
		assertEquals(parsed.isAllowed("/shared/x", "beta"), false);
	});

	await t.step("a named group replaces the * group, it does not add to it", () => {
		assertEquals(parsed.isAllowed("/private/x", "beta"), true);
		assertEquals(parsed.isAllowed("/private/x", "unnamed-bot"), false);
	});

	await t.step("two groups naming one agent are unioned", () => {
		assertEquals(parsed.isAllowed("/one/x", "mybot"), false);
		assertEquals(parsed.isAllowed("/two/x", "mybot"), false);
		assertEquals(parsed.isAllowed("/private/x", "mybot"), true);
	});
});

Deno.test("fixture robots/crawl-delay.txt — which value wins", async (t) => {
	const parsed = parseRobotsTxt(robots("crawl-delay.txt"));

	await t.step("within one group the FIRST value wins", () => {
		assertEquals(parsed.groups[1].crawlDelay, 2); // not the 10 that follows it
	});

	await t.step("across groups addressing one agent the LARGEST wins", () => {
		// being slower than asked is never a violation
		assertEquals(parsed.crawlDelay("slowbot"), 5);
	});

	await t.step("the * group serves every unnamed agent", () => {
		assertEquals(parsed.crawlDelay("randombot"), 1);
	});

	await t.step("a non-numeric value is no value at all", () => {
		assertEquals(parsed.crawlDelay("weirdbot"), undefined);
	});
});

Deno.test("fixture robots/empty.txt — comments only", async (t) => {
	const parsed = parseRobotsTxt(robots("empty.txt"));

	await t.step("no groups, no sitemaps", () => {
		assertEquals(parsed.groups, []);
		assertEquals(parsed.sitemaps, []);
	});

	await t.step("and therefore everything is allowed", () => {
		assertEquals(parsed.isAllowed("/anything", "mybot"), true);
		assertEquals(parsed.crawlDelay("mybot"), undefined);
	});
});

Deno.test("fixture robots/bom-crlf.txt — byte-level tolerances", async (t) => {
	const source = robots("bom-crlf.txt");
	const parsed = parseRobotsTxt(source);

	await t.step("the fixture really carries a BOM and CRLF endings", () => {
		assertEquals(source.charCodeAt(0), 0xfeff);
		assert(source.includes("\r\n"));
	});

	await t.step("neither reaches the parsed values", () => {
		assertEquals(parsed.groups[0].userAgents, ["*"]);
		assertEquals(parsed.groups[0].rules[0].pattern, "/bom-crlf/");
		assertEquals(parsed.crawlDelay("mybot"), 3);
		assertEquals(parsed.sitemaps, ["https://example.com/s.xml"]);
	});

	await t.step("and the rules actually match", () => {
		assertEquals(parsed.isAllowed("/bom-crlf/x", "mybot"), false);
	});
});

Deno.test("fixture robots/conflicting-precedence.txt", async (t) => {
	const parsed = parseRobotsTxt(robots("conflicting-precedence.txt"));
	const allowed = (path: string) => parsed.isAllowed(path, "mybot");

	await t.step("equal-length Allow and Disallow: Allow wins", () => {
		assertEquals(allowed("/p"), true);
		assertEquals(allowed("/page"), true);
	});

	await t.step("longest match wins, however deep the alternation goes", () => {
		assertEquals(allowed("/docs/"), false);
		assertEquals(allowed("/docs/public/x"), true);
		assertEquals(allowed("/docs/public/secret/x"), false);
	});

	await t.step("a wildcard Allow can outrank a literal Disallow on length", () => {
		assertEquals(allowed("/admin/x"), false);
		assertEquals(allowed("/admin/x.html"), true); // "/*.html$" is longer
	});

	await t.step("an unmatched path is allowed", () => {
		// genuinely unmatched: no rule here is a prefix of it and none anchors on it
		assertEquals(allowed("/about"), true);
		// `/plain` is NOT that case — it starts with `/p`, so it is allowed because
		// the equal-length Allow wins, not because nothing matched
		assertEquals(allowed("/plain"), true);
	});
});

Deno.test("fixture robots/hostile.txt — parses to something usable", async (t) => {
	const parsed = parseRobotsTxt(robots("hostile.txt"));

	await t.step("over-long patterns and empty rules are dropped", () => {
		// what survives: the star bomb, `Allow: /ok$`, and the long-but-legal
		// `/deep/deep/...` — the 2100-char pattern and the empty Allow/Disallow do not
		assertEquals(parsed.groups.length, 1);
		assertEquals(parsed.groups[0].rules.length, 3);
		assert(parsed.groups[0].rules.every((r) => r.pattern.length <= 2000));
	});

	await t.step("garbage lines are ignored, not fatal", () => {
		// `Disallow /no-colon-at-all`, `:::`, `User-agent:` with no value
		assertEquals(parsed.groups[0].userAgents, ["*"]);
	});

	await t.step("a negative and an overflowing Crawl-delay are both no value", () => {
		assertEquals(parsed.crawlDelay("mybot"), undefined);
	});

	await t.step(
		"an empty Sitemap line is dropped, a relative one is kept verbatim",
		() => {
			assertEquals(parsed.sitemaps, ["not-an-absolute-url"]);
		},
	);

	await t.step("the star bomb does not hang the matcher", () => {
		const path = "/" + "a".repeat(5_000);
		const started = performance.now();
		assertEquals(parsed.isAllowed(path, "mybot"), true);
		assert(
			performance.now() - started < 1000,
			"matching blew up on the star-heavy pattern",
		);
	});

	await t.step("the 100k-line half of this fixture is generated, not committed", () => {
		// doc 01 §5 asks hostile.txt for "100k lines"; a 100k-line file in the repo
		// would be pure churn, so the committed file carries the *shapes* and the
		// volume is built here — same call as giant.html. This pins the other soft
		// cap of doc 01 §4: lines past 10 000 are not read at all.
		const path = (i: number) => `/p${String(i).padStart(6, "0")}`;
		const many = "User-agent: *\n" +
			Array.from({ length: 100_000 }, (_, i) => `Disallow: ${path(i)}`).join("\n");

		const started = performance.now();
		const big = parseRobotsTxt(many);
		const elapsed = performance.now() - started;

		assertEquals(big.groups.length, 1);
		// the User-agent line counts too, so 9 999 rules survive the 10 000-line cap
		assertEquals(big.groups[0].rules.length, 9_999);
		assertEquals(big.isAllowed(path(0), "mybot"), false);
		assertEquals(big.isAllowed(path(9_998), "mybot"), false);
		// everything past the cap was never parsed
		assertEquals(big.isAllowed(path(9_999), "mybot"), true);
		assertEquals(big.isAllowed(path(99_999), "mybot"), true);
		assert(elapsed < 2000, `parsing 100k lines took ${elapsed.toFixed(0)}ms`);
	});
});

// ------------------------------------------------------------------------------------
// the corpus itself
// ------------------------------------------------------------------------------------

/**
 * A fixture nobody reads is a fixture that rots. These lists are the corpus manifest;
 * adding a file without a suite (or deleting one a suite still expects) fails here
 * rather than passing silently.
 */
Deno.test("the fixture corpus is fully exercised", async (t) => {
	await t.step("html", () => {
		assertEquals(listFixtures("html"), [
			"anchor-text.html",
			"assets.html",
			"base-href.html",
			"basic.html",
			"entities.html",
			"landmarks.html",
			"messy-unclosed.html",
			"meta-refresh.html",
			"no-landmarks.html",
			"script-noise.html",
			"srcset.html",
		]);
	});

	await t.step("robots", () => {
		assertEquals(listFixtures("robots"), [
			"basic.txt",
			"bom-crlf.txt",
			"conflicting-precedence.txt",
			"crawl-delay.txt",
			"empty.txt",
			"groups.txt",
			"hostile.txt",
			"wildcards.txt",
		]);
	});

	await t.step("and every file in it is readable and non-trivial", () => {
		// the manifests above catch an added-but-unused file; this catches one that
		// is present and empty, which a name list cannot see
		for (const name of listFixtures("html")) {
			const source = html(name);
			assert(source.length > 100, `${name} is ${source.length} bytes`);
			assert(
				extractLinks(source, BASE, { assets: true, srcset: true, iframes: true })
					.length > 0,
				`${name} yields no links at all`,
			);
		}
		for (const name of listFixtures("robots")) {
			const source = robots(name);
			assert(source.length > 0, `${name} is empty`);
			// never throws, always answers — for every file in the corpus
			assertEquals(typeof parseRobotsTxt(source).isAllowed("/x", "b"), "boolean");
		}
	});
});
