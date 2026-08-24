import { assert, assertEquals, assertFalse } from "@std/assert";
import {
	extractBaseHref,
	extractLinks,
	extractTitle,
	parseMetaRobots,
	parseRobotsTxt,
	parseXRobotsTag,
} from "../../src/extract/mod.ts";
import type { ExtractLinksOptions, RawLink } from "../../src/extract/mod.ts";
import { listFixtures, readFixture } from "../_fixtures.ts";

/**
 * The never-throws suite for `./extract`.
 *
 * Every function in this submodule is documented as total: a crawler meets truncated
 * responses, mislabeled binaries and deliberately hostile markup on a normal day, and
 * an exception there would take down a run over one bad page. A table of examples can
 * only sample that; these tests generate the inputs instead — from a fixed seed, so a
 * failure is reproducible from the printed input alone and never from a lucky
 * `Math.random`.
 *
 * Three things are checked, not one:
 *
 * 1. **No throw**, for any input, under any option profile.
 * 2. **A well-formed result** — a total function that returns nonsense on garbage would
 *    pass a bare "it did not throw" test while poisoning the frontier. Every returned
 *    link is checked against its own type: non-empty `href`, a known `tag`/`rel`, a
 *    parsable `url`, a real landmark, the caps respected.
 * 3. **Determinism** — the same input twice gives the same answer, which is what pins
 *    the module-level `/g` regex in `parseAttrs` down to being stateless in practice.
 *
 * Termination is its own section: "never throws" is worthless if the answer arrives
 * after twenty seconds of blocked event loop, and that failure mode has already
 * happened twice in this package (a quadratic trailing-slash regex, an exponential
 * robots glob).
 */

const SEED = 0x1d3b7c5;
const BASE = "https://example.com/dir/page.html";

/** xorshift32 — same generator the `./url` property suite uses, same reason. */
function makeRandom(seed: number): () => number {
	let state = seed | 0 || 1;
	return () => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return (state >>> 0) / 0x100000000;
	};
}

const TAGS: ReadonlySet<string> = new Set([
	"a",
	"area",
	"link",
	"iframe",
	"frame",
	"meta",
	"img",
	"script",
	"source",
	"video",
	"audio",
]);

const RELS: ReadonlySet<string> = new Set([
	"page",
	"asset",
	"canonical",
	"alternate",
	"next",
	"prev",
	"iframe",
]);

const REGIONS: ReadonlySet<string> = new Set([
	"main",
	"article",
	"nav",
	"header",
	"footer",
	"aside",
]);

/** Option profiles the fuzz runs every input through. */
const PROFILES: { name: string; opts: ExtractLinksOptions }[] = [
	{ name: "defaults", opts: {} },
	{
		name: "everything-on",
		opts: {
			anchors: true,
			canonical: true,
			nextPrev: true,
			metaRefresh: true,
			alternate: true,
			iframes: true,
			assets: true,
			srcset: true,
		},
	},
	{
		name: "everything-off",
		opts: {
			anchors: false,
			canonical: false,
			nextPrev: false,
			metaRefresh: false,
			alternate: false,
			iframes: false,
			assets: false,
			srcset: false,
		},
	},
	{
		name: "tiny-caps",
		opts: { assets: true, srcset: true, maxLinks: 3, maxAnchorText: 1 },
	},
	{ name: "no-base-detection", opts: { detectBase: false } },
];

/**
 * Everything {@linkcode RawLink} promises, asserted. This is the half of the fuzz that
 * "it did not throw" cannot cover.
 */
function assertWellFormed(
	links: RawLink[],
	opts: ExtractLinksOptions,
	input: string,
): void {
	const where = (msg: string) =>
		`${msg} — for input ${JSON.stringify(input.slice(0, 200))}`;

	assert(Array.isArray(links), where("not an array"));
	assert(links.length <= (opts.maxLinks ?? 10_000), where("maxLinks exceeded"));

	for (const link of links) {
		assert(typeof link.href === "string", where("href is not a string"));
		assert(link.href !== "", where("empty href"));
		assertEquals(link.href, link.href.trim(), where("href is not trimmed"));
		assert(TAGS.has(link.tag), where(`unknown tag ${link.tag}`));
		assert(RELS.has(link.rel), where(`unknown rel ${link.rel}`));
		assertEquals(typeof link.nofollow, "boolean", where("nofollow"));
		assertEquals(typeof link.ugc, "boolean", where("ugc"));
		assertEquals(typeof link.sponsored, "boolean", where("sponsored"));

		if (link.region !== undefined) {
			assert(REGIONS.has(link.region), where(`unknown region ${link.region}`));
		}
		if (link.anchorText !== undefined) {
			assertEquals(link.tag, "a", where("anchor text on a non-anchor"));
			assert(
				link.anchorText.length <= (opts.maxAnchorText ?? 200),
				where("anchor text over the cap"),
			);
		}
		if (link.hreflang !== undefined) {
			assertEquals(typeof link.hreflang, "string", where("hreflang"));
		}
		if (link.url !== undefined) {
			// it came out of `new URL(...).href`, so it must go back in
			new URL(link.url);
		}
	}
}

/**
 * Every `./extract` entry point, over one input, twice. Must not throw — and must not
 * answer with something that violates its own type.
 *
 * @returns how many links came back, so a caller can assert that its generator is
 * actually reaching the well-formedness checks rather than feeding 1500 inputs that
 * all yield nothing.
 */
function exercise(input: string, opts: ExtractLinksOptions): number {
	const where = (msg: string) =>
		`${msg} — for input ${JSON.stringify(input.slice(0, 200))}`;

	const links = extractLinks(input, BASE, opts);
	assertWellFormed(links, opts, input);
	// determinism: nothing in this module may carry state between calls
	assertEquals(
		extractLinks(input, BASE, opts),
		links,
		where("not deterministic"),
	);

	const title = extractTitle(input);
	if (title !== undefined) {
		assertEquals(typeof title, "string", where("title"));
		assert(title !== "", where("an empty title should be undefined"));
		assert(title.length <= 512, where("title over the default cap"));
		// collapsed and trimmed, always
		assertEquals(title, title.replace(/\s+/g, " ").trim(), where("title shape"));
	}

	// the base is always a string, and always something `URL` can accept — a base
	// that does not parse would silently leave every link's `url` undefined
	const base = extractBaseHref(input, BASE);
	assertEquals(typeof base, "string", where("base type"));
	new URL(base);

	const meta = parseMetaRobots(input);
	assertEquals(typeof meta.noindex, "boolean", where("meta.noindex"));
	assertEquals(typeof meta.nofollow, "boolean", where("meta.nofollow"));
	assert(Array.isArray(meta.raw), where("meta.raw"));
	// `raw` holds lowercased, deduped tokens
	assertEquals(meta.raw, [...new Set(meta.raw)], where("meta.raw is deduped"));
	assert(meta.raw.every((t) => t === t.toLowerCase()), where("meta.raw casing"));

	const header = parseXRobotsTag(input, { botName: "mybot" });
	assert(Array.isArray(header.raw), where("header.raw"));
	assertEquals(header.raw, [...new Set(header.raw)], where("header.raw is deduped"));

	// the same bytes could just as well have been served as a robots.txt
	const robots = parseRobotsTxt(input);
	assert(Array.isArray(robots.groups), where("robots.groups"));
	assertEquals(typeof robots.isAllowed("/x", "mybot"), "boolean", where("isAllowed"));
	for (const group of robots.groups) {
		assert(Array.isArray(group.userAgents), where("group.userAgents"));
		assert(group.rules.every((r) => r.pattern.length <= 2_000), where("pattern cap"));
	}

	return links.length;
}

// ------------------------------------------------------------------------------------
// generated input
// ------------------------------------------------------------------------------------

/** Real bytes, decoded the way a fetcher would decode a mislabeled binary. */
function randomBytes(random: () => number, length: number): string {
	const bytes = new Uint8Array(length);
	for (let i = 0; i < length; i++) bytes[i] = Math.floor(random() * 256);
	return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

/**
 * Markup-shaped noise: the pieces a tokenizer actually has to make decisions about,
 * shuffled into orders no document would ever contain.
 */
const PIECES = [
	"<a",
	"<A",
	"</a>",
	"<link",
	"<meta",
	"<base",
	"<img",
	"<script",
	"</script>",
	"<style",
	"<title",
	"</title>",
	"<textarea",
	"<noscript>",
	"<main>",
	"</main>",
	"<article>",
	"<nav>",
	"</nav>",
	"<header>",
	"<footer>",
	"</footer>",
	"<aside>",
	"<!--",
	"-->",
	"<![CDATA[",
	"]]>",
	"<!DOCTYPE html>",
	"<?php",
	"?>",
	"<",
	">",
	"</",
	"/>",
	" href=",
	" href",
	" HREF = ",
	" src=",
	" srcset=",
	" rel=",
	" rel='nofollow ugc'",
	' rel="canonical"',
	' rel="alternate stylesheet"',
	" http-equiv=refresh",
	" content=",
	' content="5; url=/x"',
	" hreflang=de",
	" name=robots",
	" __proto__=x",
	'"',
	"'",
	"=",
	"/",
	"\\",
	"\u0000",
	"&amp;",
	"&#x110000;",
	"&#;",
	"&",
	";",
	"%",
	"%2",
	"%zz",
	"\uD800",
	"\uDFFF",
	"é",
	"日",
	"🙂",
	" ",
	"\t",
	"\n",
	"\r",
	"\f",
	"/x",
	"//host/p",
	"http://a.com/",
	"javascript:void(0)",
	"data:text/html,<a href=/y>",
	"#",
	"?a=1",
];

/** Pieces a tag is assembled from, so the generator produces real links, not only soup. */
// weighted by repetition: `a` and `link` are what produce links, while the raw-text
// elements swallow everything after them (exactly as in a browser) and so must stay
// rare or the generator spends its budget generating documents with no markup left
const TAG_NAMES = [
	"a",
	"a",
	"a",
	"a",
	"a",
	"area",
	"link",
	"link",
	"meta",
	"meta",
	"img",
	"img",
	"iframe",
	"frame",
	"source",
	"video",
	"audio",
	"base",
	"main",
	"article",
	"nav",
	"footer",
	"div",
	"noscript",
	"svg",
	"script",
	"title",
	"textarea",
];

const ATTR_NAMES = [
	"href",
	"href",
	"href",
	"src",
	"HREF",
	"src",
	"srcset",
	"rel",
	"content",
	"http-equiv",
	"hreflang",
	"poster",
	"name",
	"class",
	"__proto__",
	"data-x",
	"href",
];

const ATTR_VALUES = [
	"/x",
	"//host/p",
	"http://a.com/",
	"https://a.com/a b",
	"javascript:void(0)",
	"mailto:a@b.c",
	"#frag",
	"?a=1",
	"x.html",
	"../y",
	"",
	"   ",
	"5; url=/n",
	"0,/n",
	"nofollow ugc",
	"canonical",
	"next",
	"alternate stylesheet",
	"refresh",
	"robots",
	"noindex, nofollow",
	"/a 1x, /b 2x",
	'a"b',
	"&amp;/x",
	"%",
	"%2",
	"🙂",
	"\uD800",
];

const QUOTES = ['"', "'", ""];
const TERMINATORS = [">", "/>", " >", "", "<", "\n>"];
const TEXT = ["t", "hello world", "a & b", "&amp;", "\n\t ", "<3", ""];

/** One tag-shaped construct, well-formed often enough to matter and never twice alike. */
function randomTag(random: () => number): string {
	const pick = <T>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)];
	let out = (random() < 0.15 ? "</" : "<") + pick(TAG_NAMES);
	const attrs = Math.floor(random() * 4);
	for (let i = 0; i < attrs; i++) {
		out += " " + pick(ATTR_NAMES);
		if (random() < 0.85) {
			const quote = pick(QUOTES);
			out += (random() < 0.9 ? "=" : " = ") + quote + pick(ATTR_VALUES) +
				// an unterminated quoted value is one of the shapes we care about
				(random() < 0.9 ? quote : "");
		}
	}
	return out + pick(TERMINATORS);
}

/**
 * Markup-shaped noise: mostly assembled tags (so links, titles and directives are
 * actually produced and the well-formedness assertions get exercised), sprinkled with
 * the raw fragments a tokenizer has to make decisions about.
 */
function randomMarkup(random: () => number, pieces: number): string {
	let out = "";
	for (let i = 0; i < pieces; i++) {
		const roll = random();
		if (roll < 0.5) out += randomTag(random);
		else if (roll < 0.65) out += TEXT[Math.floor(random() * TEXT.length)];
		else out += PIECES[Math.floor(random() * PIECES.length)];
	}
	return out;
}

const HTML_FIXTURES = listFixtures("html").map((name) => readFixture("html", name));

// ------------------------------------------------------------------------------------
// tests
// ------------------------------------------------------------------------------------

Deno.test("fuzz: random bytes never throw", () => {
	// Deliberately a pure totality check: uniformly random bytes essentially never
	// spell a tag, so this generator yields no links and reaches none of the
	// well-formedness assertions. That is what the markup-shaped generator below is
	// for, and why this test asserts the yield is what it is rather than leaving the
	// reader to assume coverage it does not have.
	const random = makeRandom(SEED);
	let links = 0;
	for (let i = 0; i < 1500; i++) {
		const input = randomBytes(random, Math.floor(random() * 300));
		links += exercise(input, PROFILES[Math.floor(random() * PROFILES.length)].opts);
	}
	assertEquals(links, 0, "random bytes started producing links — good, but retune");
});

Deno.test("fuzz: markup-shaped noise never throws", () => {
	const random = makeRandom(SEED ^ 0x51ed270b);
	let links = 0;
	for (let i = 0; i < 2500; i++) {
		const input = randomMarkup(random, 10 + Math.floor(random() * 60));
		links += exercise(input, PROFILES[Math.floor(random() * PROFILES.length)].opts);
	}
	// this generator is the one that has to reach `assertWellFormed`'s per-link
	// checks; without a floor here a change to PIECES could silently gut them
	// A floor, not a pin. The seed is fixed, so this number is reproducible; it is
	// here because the obvious version of this generator produced 0.13 links per
	// input, which left `assertWellFormed` almost entirely dead while still looking
	// like a 2500-iteration fuzz.
	assert(links > 1000, `only ${links} links generated — the checks are barely running`);
});

Deno.test("fuzz: every prefix of every fixture is safe", async (t) => {
	// a truncated response is the single most likely malformed input a crawler sees:
	// the connection dropped, or a byte cap cut the body mid-tag
	await t.step("random truncations", () => {
		const random = makeRandom(SEED ^ 0x2c9e15a3);
		let links = 0;
		for (const source of HTML_FIXTURES) {
			for (let i = 0; i < 200; i++) {
				const cut = Math.floor(random() * (source.length + 1));
				links += exercise(
					source.slice(0, cut),
					PROFILES[Math.floor(random() * PROFILES.length)].opts,
				);
			}
		}
		assert(links > 1000, `only ${links} links from truncated fixtures`);
	});

	await t.step("every single-character prefix of the smallest fixture", () => {
		// exhaustive rather than sampled — cheap, and it covers the off-by-one
		// truncations a random cut is unlikely to hit
		const source = HTML_FIXTURES.reduce((a, b) => (a.length <= b.length ? a : b));
		for (let cut = 0; cut <= source.length; cut++) {
			exercise(source.slice(0, cut), {});
		}
	});

	await t.step("fixtures with random bytes spliced in", () => {
		const random = makeRandom(SEED ^ 0x7a41f0d9);
		let links = 0;
		for (const source of HTML_FIXTURES) {
			for (let i = 0; i < 60; i++) {
				const at = Math.floor(random() * source.length);
				const junk = randomBytes(random, 1 + Math.floor(random() * 40));
				links += exercise(
					source.slice(0, at) + junk + source.slice(at),
					PROFILES[Math.floor(random() * PROFILES.length)].opts,
				);
			}
		}
		assert(links > 500, `only ${links} links from spliced fixtures`);
	});
});

Deno.test("fuzz: non-string input is not an error either", () => {
	const values = [
		undefined,
		null,
		0,
		1,
		NaN,
		true,
		{},
		[],
		Symbol.iterator,
		() => {},
	];
	for (const value of values) {
		// deno-lint-ignore no-explicit-any
		const v = value as any;
		assertEquals(extractLinks(v, BASE), []);
		assertEquals(extractLinks("<a href=/x>y</a>", v), [{
			href: "/x",
			tag: "a",
			rel: "page",
			nofollow: false,
			ugc: false,
			sponsored: false,
			anchorText: "y",
		}]);
		assertEquals(extractTitle(v), undefined);
		assertEquals(extractBaseHref(v, BASE), BASE);
		assertEquals(parseMetaRobots(v).raw, []);
		assertEquals(parseXRobotsTag(v).raw, []);
		assertEquals(parseRobotsTxt(v).groups, []);
	}
});

Deno.test("fuzz: options are never a reason to throw", () => {
	const random = makeRandom(SEED ^ 0x3f0a9c17);
	const numbers = [-1, 0, 0.5, NaN, Infinity, -Infinity, 1e9];
	// deno-lint-ignore no-explicit-any
	const junk: any[] = [undefined, null, "yes", {}, [], () => {}];

	for (let i = 0; i < 400; i++) {
		const input = randomMarkup(random, Math.floor(random() * 40));
		const pick = <T>(xs: T[]): T => xs[Math.floor(random() * xs.length)];
		// deno-lint-ignore no-explicit-any
		const opts: any = {
			anchors: pick(junk),
			assets: pick(junk),
			srcset: pick(junk),
			maxLinks: pick([...numbers, ...junk]),
			maxAnchorText: pick([...numbers, ...junk]),
			detectBase: pick(junk),
		};
		const links = extractLinks(input, BASE, opts);
		assert(Array.isArray(links));
		for (const link of links) {
			assert(link.href !== "");
			assert(TAGS.has(link.tag));
			assert(RELS.has(link.rel));
		}
		const title = extractTitle(input, opts);
		assert(title === undefined || typeof title === "string");
	}
});

Deno.test("fuzz: a junk cap falls back to the default, it is never honored as junk", () => {
	// the assertion the option fuzz above cannot make: its inputs are far too small
	// for any cap to bite, so `links.length <= 10_000` there is a ceiling nothing can
	// reach. Here the cap actually applies.
	const many = '<a href="/x">t</a>'.repeat(12_000);
	// deno-lint-ignore no-explicit-any
	for (const junk of [0, -1, 0.5, NaN, "50", null, undefined, {}] as any[]) {
		assertEquals(
			extractLinks(many, BASE, { maxLinks: junk }).length,
			10_000,
			`maxLinks: ${JSON.stringify(junk)} did not fall back to the default`,
		);
	}
	// a legal cap is still honored, so the fallback is not just "ignore the option"
	assertEquals(extractLinks(many, BASE, { maxLinks: 7 }).length, 7);
	assertEquals(extractLinks(many, BASE, { maxLinks: Infinity }).length, 12_000);

	// same shape for the title cap
	const title = `<title>${"t".repeat(2_000)}</title>`;
	// deno-lint-ignore no-explicit-any
	for (const junk of [0, -1, 0.5, NaN, "50", null] as any[]) {
		assertEquals(extractTitle(title, { maxLength: junk })?.length, 512);
	}
	assertEquals(extractTitle(title, { maxLength: 10 })?.length, 10);
});

// ------------------------------------------------------------------------------------
// termination
// ------------------------------------------------------------------------------------

/**
 * Pathologies that a site can serve on purpose. Each must finish fast — an answer that
 * arrives after twenty seconds of blocked event loop is not an answer, and the two
 * regexes this package has already had to hand-write were both found exactly here.
 */
Deno.test("fuzz: hostile shapes terminate quickly", async (t) => {
	const budget = 2000;
	const timed = (name: string, fn: () => void) => {
		const started = performance.now();
		fn();
		const elapsed = performance.now() - started;
		assert(elapsed < budget, `${name} took ${elapsed.toFixed(0)}ms`);
	};

	await t.step("200k stray '<'", () => {
		const input = "<".repeat(200_000);
		timed("stray <", () => {
			assertEquals(extractLinks(input, BASE), []);
			assertEquals(extractTitle(input), undefined);
		});
	});

	await t.step("100k unterminated tags", () => {
		const input = '<a href="/x'.repeat(100_000);
		timed("unterminated tags", () => {
			// the whole thing is one unterminated tag, so at most one link
			assert(extractLinks(input, BASE).length <= 1);
		});
	});

	await t.step("one tag with 100k attributes", () => {
		const input = "<a " + 'x="y" '.repeat(100_000) + 'href="/z">t</a>';
		timed("attribute run", () => {
			const links = extractLinks(input, BASE);
			assertEquals(links.length, 1);
			assertEquals(links[0].href, "/z");
		});
	});

	await t.step("one attribute value of 1M characters", () => {
		const input = '<a href="' + "x".repeat(1_000_000) + '">t</a>';
		timed("giant value", () => {
			const links = extractLinks(input, BASE);
			assertEquals(links.length, 1);
			assertEquals(links[0].href.length, 1_000_000);
		});
	});

	await t.step("100k nested landmarks", () => {
		// MAX_REGION_DEPTH caps what the stack remembers; the scan itself must stay
		// linear regardless
		const input = "<main>".repeat(100_000) + '<a href="/deep">t</a>';
		timed("landmark nesting", () => {
			const links = extractLinks(input, BASE);
			assertEquals(links.length, 1);
			assertEquals(links[0].region, "main");
		});
	});

	await t.step("100k unbalanced landmark closes", () => {
		const input = "</main>".repeat(100_000) + '<a href="/x">t</a>';
		timed("landmark closes", () => {
			const links = extractLinks(input, BASE);
			assertEquals(links.length, 1);
			// the link is really there; its region is really absent
			assertFalse("region" in links[0]);
		});
	});

	await t.step("200k entities in one href", () => {
		const input = `<a href="/x?${"&amp;".repeat(200_000)}">t</a>`;
		timed("entity run", () => {
			const links = extractLinks(input, BASE);
			assertEquals(links.length, 1);
			assertEquals(links[0].href.length, 200_003);
		});
	});

	await t.step("a run of undecodable ampersands scales linearly", () => {
		// The bug this pins is quadratic, not slow: the `;` search used to run to the
		// end of the document for every `&` that was not an entity. A wall-clock
		// ceiling is the wrong instrument for it — at 200k the broken version took
		// ~0.9 s, which sails under any budget generous enough not to be flaky on a
		// loaded machine. So measure the growth rate instead.
		const timeFor = (n: number) => {
			const input = `<a href="/x?${"&".repeat(n)}">t</a>`;
			let best = Infinity;
			for (let run = 0; run < 3; run++) {
				const started = performance.now();
				const links = extractLinks(input, BASE);
				assertEquals(links[0]?.href.length, n + 3);
				best = Math.min(best, performance.now() - started);
			}
			return best;
		};
		const small = timeFor(100_000);
		const large = timeFor(400_000);
		// 4x the input: linear is ~4x, the old quadratic was ~17x
		assert(
			large < 8 * Math.max(small, 1),
			`100k ampersands took ${small.toFixed(1)}ms but 400k took ` +
				`${large.toFixed(1)}ms — the entity scan is unbounded again`,
		);
		assert(large < 800, `400k ampersands took ${large.toFixed(0)}ms`);
	});

	await t.step("an unclosed <script> swallowing 1M characters", () => {
		const input = "<script>" + '<a href="/x">'.repeat(80_000);
		timed("unclosed script", () => {
			assertEquals(extractLinks(input, BASE), []);
		});
	});

	await t.step("a 1M-character anchor body", () => {
		// the anchor-text search is window-capped, so this must not cost more than
		// the scan itself
		const input = '<a href="/x">' + "t".repeat(1_000_000) + "</a>";
		timed("anchor body", () => {
			const links = extractLinks(input, BASE);
			assertEquals(links.length, 1);
			assertEquals(links[0].anchorText?.length, 200);
		});
	});

	await t.step("20k anchors with long bodies — 20 MB of document", () => {
		const input = ('<a href="/x">' + "word ".repeat(200) + "</a>").repeat(20_000);
		timed("many anchors with text", () => {
			assertEquals(extractLinks(input, BASE).length, 10_000); // the default cap
		});
	});

	await t.step("a robots.txt of 200k comment lines", () => {
		const input = "#".repeat(100) + "\n".repeat(200_000);
		timed("robots comments", () => {
			assertEquals(parseRobotsTxt(input).groups, []);
		});
	});

	await t.step("an X-Robots-Tag of 200k tokens", () => {
		const input = "noindex,".repeat(200_000);
		timed("x-robots-tag", () => {
			assertEquals(parseXRobotsTag(input).noindex, true);
		});
	});
});
