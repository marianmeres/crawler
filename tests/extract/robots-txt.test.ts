import { assert, assertEquals, assertFalse } from "@std/assert";
import {
	parseRobotsTxt,
	robotsAllowAll,
	robotsDisallowAll,
} from "../../src/extract/mod.ts";

const UA = "marianmeres-crawler";

Deno.test("parseRobotsTxt: the shape of a plain file", async (t) => {
	const robots = parseRobotsTxt(`
# a comment
User-agent: *
Disallow: /private
Allow: /private/public
Crawl-delay: 2.5

User-agent: BadBot
User-agent: WorseBot
Disallow: /

Sitemap: https://example.com/sitemap.xml
	`);

	await t.step("groups keep source order and lowercased agents", () => {
		assertEquals(robots.groups.length, 2);
		assertEquals(robots.groups[0].userAgents, ["*"]);
		assertEquals(robots.groups[1].userAgents, ["badbot", "worsebot"]);
	});

	await t.step("rules keep their patterns as written", () => {
		assertEquals(robots.groups[0].rules, [
			{ allow: false, pattern: "/private" },
			{ allow: true, pattern: "/private/public" },
		]);
	});

	await t.step("crawl-delay parses as a float", () => {
		assertEquals(robots.groups[0].crawlDelay, 2.5);
		assertEquals(robots.groups[1].crawlDelay, undefined);
		assertEquals(robots.crawlDelay(UA), 2.5);
		assertEquals(robots.crawlDelay("BadBot/1.0"), undefined);
	});

	await t.step("Sitemap survives its own colon", () => {
		assertEquals(robots.sitemaps, ["https://example.com/sitemap.xml"]);
	});

	await t.step("the rules actually apply", () => {
		assertFalse(robots.isAllowed("/private/x", UA));
		assert(robots.isAllowed("/private/public/x", UA));
		assert(robots.isAllowed("/", UA));
		assertFalse(robots.isAllowed("/anything", "BadBot/1.0"));
	});
});

Deno.test("parseRobotsTxt: grammar tolerances", async (t) => {
	await t.step("BOM, CRLF and stray whitespace", () => {
		const robots = parseRobotsTxt(
			"﻿  User-Agent :  *  \r\n\tDisallow:\t/x\r\n",
		);
		assertEquals(robots.groups[0].userAgents, ["*"]);
		assertFalse(robots.isAllowed("/x", UA));
	});

	await t.step("comments are stripped mid-line", () => {
		const robots = parseRobotsTxt(
			"User-agent: *\nDisallow: /x # keep out\n#all mine",
		);
		assertEquals(robots.groups[0].rules[0].pattern, "/x");
	});

	await t.step("directive names are case-insensitive", () => {
		const robots = parseRobotsTxt("USER-AGENT: *\nDISALLOW: /x\nSITEMAP: /s.xml");
		assertFalse(robots.isAllowed("/x", UA));
		assertEquals(robots.sitemaps, ["/s.xml"]);
	});

	await t.step("consecutive User-agent lines are one group", () => {
		const robots = parseRobotsTxt("User-agent: a\nUser-agent: b\nDisallow: /x");
		assertEquals(robots.groups.length, 1);
		assertEquals(robots.groups[0].userAgents, ["a", "b"]);
	});

	await t.step("a rule before any User-agent opens an implicit * group", () => {
		const robots = parseRobotsTxt("Disallow: /x\nUser-agent: bot\nDisallow: /y");
		assertEquals(robots.groups.length, 2);
		assertEquals(robots.groups[0].userAgents, ["*"]);
		assertFalse(robots.isAllowed("/x", UA));
		assert(robots.isAllowed("/y", UA));
	});

	await t.step("a User-agent after a rule starts a new group", () => {
		const robots = parseRobotsTxt(
			"User-agent: a\nDisallow: /1\nUser-agent: b\nDisallow: /2",
		);
		assertEquals(robots.groups.length, 2);
		assertEquals(robots.groups[1].userAgents, ["b"]);
	});

	await t.step("an empty Disallow contributes nothing", () => {
		const robots = parseRobotsTxt("User-agent: *\nDisallow:");
		assertEquals(robots.groups[0].rules, []);
		assert(robots.isAllowed("/anything", UA));
	});

	await t.step("an empty Allow contributes nothing either", () => {
		const robots = parseRobotsTxt("User-agent: *\nDisallow: /\nAllow:");
		assertEquals(robots.groups[0].rules.length, 1);
		assertFalse(robots.isAllowed("/x", UA));
	});

	await t.step("unknown directives and colon-less lines are ignored", () => {
		const robots = parseRobotsTxt(
			"User-agent: *\nHost: example.com\nnonsense\nDisallow: /x",
		);
		assertEquals(robots.groups.length, 1);
		assertEquals(robots.groups[0].rules.length, 1);
	});

	await t.step("a Sitemap anywhere is global", () => {
		const robots = parseRobotsTxt(
			"Sitemap: /a.xml\nUser-agent: *\nDisallow: /x\nSitemap: /b.xml",
		);
		assertEquals(robots.sitemaps, ["/a.xml", "/b.xml"]);
	});

	await t.step("a User-agent with no value is not a group", () => {
		const robots = parseRobotsTxt("User-agent:\nDisallow: /x");
		assertEquals(robots.groups.length, 1);
		assertEquals(robots.groups[0].userAgents, ["*"]);
	});

	await t.step("an unparsable or negative Crawl-delay is dropped", () => {
		assertEquals(
			parseRobotsTxt("User-agent: *\nCrawl-delay: soon").groups[0].crawlDelay,
			undefined,
		);
		assertEquals(
			parseRobotsTxt("User-agent: *\nCrawl-delay: -5").groups[0].crawlDelay,
			undefined,
		);
		assertEquals(
			parseRobotsTxt("User-agent: *\nCrawl-delay: 1\nCrawl-delay: 9")
				.groups[0].crawlDelay,
			1,
		);
	});
});

Deno.test("RobotsTxt.isAllowed: precedence", async (t) => {
	await t.step("no rules at all means allowed", () => {
		assert(parseRobotsTxt("").isAllowed("/x", UA));
		assert(parseRobotsTxt("User-agent: *").isAllowed("/x", UA));
	});

	await t.step("the longest matching pattern wins, in either direction", () => {
		const robots = parseRobotsTxt(
			"User-agent: *\nDisallow: /a\nAllow: /a/b\nDisallow: /a/b/c",
		);
		assertFalse(robots.isAllowed("/a/x", UA));
		assert(robots.isAllowed("/a/b/x", UA));
		assertFalse(robots.isAllowed("/a/b/c/x", UA));
	});

	await t.step("equal length is a tie, and Allow wins a tie", () => {
		assert(
			parseRobotsTxt("User-agent: *\nDisallow: /x\nAllow: /x").isAllowed("/x", UA),
		);
		assert(
			parseRobotsTxt("User-agent: *\nAllow: /x\nDisallow: /x").isAllowed("/x", UA),
		);
	});

	await t.step("rules are prefixes, not whole-path matches", () => {
		const robots = parseRobotsTxt("User-agent: *\nDisallow: /priv");
		assertFalse(robots.isAllowed("/private/deep/page", UA));
		assert(robots.isAllowed("/pri", UA));
	});

	await t.step("Disallow: / stops everything", () => {
		const robots = parseRobotsTxt("User-agent: *\nDisallow: /");
		assertFalse(robots.isAllowed("/", UA));
		assertFalse(robots.isAllowed("/x?y=1", UA));
	});

	await t.step("paths are case-sensitive", () => {
		const robots = parseRobotsTxt("User-agent: *\nDisallow: /Private");
		assertFalse(robots.isAllowed("/Private", UA));
		assert(robots.isAllowed("/private", UA));
	});
});

Deno.test("RobotsTxt.isAllowed: wildcards", async (t) => {
	const robots = parseRobotsTxt(`
User-agent: *
Disallow: /*.pdf$
Disallow: /a/*/secret
Disallow: /q?*sort=
Allow: /*.pdf$?ok
	`);

	await t.step("$ anchors the end of the path", () => {
		assertFalse(robots.isAllowed("/docs/manual.pdf", UA));
		assert(robots.isAllowed("/docs/manual.pdf?download=1", UA));
		assert(robots.isAllowed("/docs/manual.pdfx", UA));
	});

	await t.step("* spans any run of characters, including none", () => {
		assertFalse(robots.isAllowed("/a/b/secret", UA));
		assertFalse(robots.isAllowed("/a//secret", UA));
		assertFalse(robots.isAllowed("/a/b/c/d/secret/x", UA));
		assert(robots.isAllowed("/a/b/public", UA));
	});

	await t.step("a query string is part of the match target", () => {
		assertFalse(robots.isAllowed("/q?a=1&sort=asc", UA));
		assert(robots.isAllowed("/q?a=1", UA));
	});

	await t.step("regex metacharacters in a pattern are literal", () => {
		const re = parseRobotsTxt("User-agent: *\nDisallow: /a+b(c)[d].e");
		assertFalse(re.isAllowed("/a+b(c)[d].e", UA));
		assert(re.isAllowed("/aab_c_d_xe", UA));
	});

	await t.step("a $ in the middle is a literal $", () => {
		const dollar = parseRobotsTxt("User-agent: *\nDisallow: /a$b");
		assertFalse(dollar.isAllowed("/a$b/c", UA));
		assert(dollar.isAllowed("/a", UA));
	});

	await t.step("consecutive stars behave like one", () => {
		const stars = parseRobotsTxt("User-agent: *\nDisallow: /a**b");
		assertFalse(stars.isAllowed("/axxb", UA));
		assertFalse(stars.isAllowed("/ab", UA));
	});
});

Deno.test("RobotsTxt: group selection", async (t) => {
	const robots = parseRobotsTxt(`
User-agent: *
Disallow: /star

User-agent: crawler
Crawl-delay: 1
Disallow: /generic

User-agent: marianmeres-crawler
Crawl-delay: 3
Disallow: /specific
	`);

	await t.step("the longest matching token wins, and only it applies", () => {
		assertFalse(robots.isAllowed("/specific", "marianmeres-crawler/1.0"));
		assert(robots.isAllowed("/generic", "marianmeres-crawler/1.0"));
		assert(robots.isAllowed("/star", "marianmeres-crawler/1.0"));
		assertEquals(robots.crawlDelay("marianmeres-crawler/1.0"), 3);
	});

	await t.step("a shorter token still matches when it is the only one", () => {
		assertFalse(robots.isAllowed("/generic", "some-crawler-thing"));
		assertEquals(robots.crawlDelay("some-crawler-thing"), 1);
	});

	await t.step("token matching is case-insensitive", () => {
		assertFalse(robots.isAllowed("/specific", "MarianMeres-Crawler/2"));
	});

	await t.step("an unknown agent falls back to the * group", () => {
		assertFalse(robots.isAllowed("/star", "GoogleBot"));
		assert(robots.isAllowed("/specific", "GoogleBot"));
	});

	await t.step("with no * group and no match, everything is allowed", () => {
		const named = parseRobotsTxt("User-agent: onlybot\nDisallow: /");
		assert(named.isAllowed("/x", UA));
		assertFalse(named.isAllowed("/x", "onlybot"));
	});

	await t.step("groups naming the same agent are unioned, delay is the largest", () => {
		const twice = parseRobotsTxt(`
User-agent: bot
Crawl-delay: 2
Disallow: /one

User-agent: bot
Crawl-delay: 7
Disallow: /two
		`);
		assertFalse(twice.isAllowed("/one", "bot"));
		assertFalse(twice.isAllowed("/two", "bot"));
		assertEquals(twice.crawlDelay("bot"), 7);
	});

	await t.step("several * groups are unioned too", () => {
		const twice = parseRobotsTxt(
			"User-agent: *\nDisallow: /one\n\nUser-agent: *\nDisallow: /two",
		);
		assertFalse(twice.isAllowed("/one", UA));
		assertFalse(twice.isAllowed("/two", UA));
	});
});

Deno.test("RobotsTxt.isAllowed: what the caller may pass", async (t) => {
	const robots = parseRobotsTxt("User-agent: *\nDisallow: /private");

	await t.step("path + query, the documented form", () => {
		assertFalse(robots.isAllowed("/private?a=1", UA));
	});

	await t.step("a whole URL is reduced to path + query", () => {
		assertFalse(robots.isAllowed("https://example.com/private/x?a=1", UA));
		assert(robots.isAllowed("https://example.com/public", UA));
	});

	await t.step("a missing leading slash is added", () => {
		assertFalse(robots.isAllowed("private/x", UA));
	});

	await t.step("a fragment is not part of the decision", () => {
		assert(robots.isAllowed("/public#/private", UA));
	});

	await t.step("empty and non-string targets mean the root", () => {
		assert(robots.isAllowed("", UA));
		// deno-lint-ignore no-explicit-any
		assert(robots.isAllowed(null as any, UA));
		assertFalse(parseRobotsTxt("User-agent: *\nDisallow: /").isAllowed("", UA));
	});

	await t.step("percent-encoding is compared as written", () => {
		const enc = parseRobotsTxt("User-agent: *\nDisallow: /a%20b");
		assertFalse(enc.isAllowed("/a%20b", UA));
		assert(enc.isAllowed("/a b", UA));
	});

	await t.step("a missing user agent falls back to the * group", () => {
		// deno-lint-ignore no-explicit-any
		assertFalse(robots.isAllowed("/private", undefined as any));
	});
});

Deno.test("robotsAllowAll / robotsDisallowAll", async (t) => {
	await t.step("they mean what they say", () => {
		assert(robotsAllowAll().isAllowed("/anything", UA));
		assertFalse(robotsDisallowAll().isAllowed("/", UA));
		assertFalse(robotsDisallowAll().isAllowed("/anything", "any-bot"));
	});

	await t.step("no sitemaps, and a fresh object each call", () => {
		assertEquals(robotsAllowAll().sitemaps, []);
		assert(robotsAllowAll() !== robotsAllowAll());
		assert(robotsDisallowAll() !== robotsDisallowAll());
	});

	await t.step("allow-all is what an empty document parses to", () => {
		assertEquals(parseRobotsTxt("").groups, robotsAllowAll().groups);
	});
});

Deno.test("parseRobotsTxt: hostile input", async (t) => {
	await t.step("lines past the cap are ignored", () => {
		// zero-padded so that no rule is a prefix of another
		const path = (i: number) => `/p${String(i).padStart(6, "0")}`;
		const many = "User-agent: *\n" +
			Array.from({ length: 20_000 }, (_, i) => `Disallow: ${path(i)}`).join("\n");
		const robots = parseRobotsTxt(many);
		assert(robots.groups[0].rules.length < 10_000);
		assertFalse(robots.isAllowed(path(1), UA));
		assert(robots.isAllowed(path(19_999), UA));
	});

	await t.step("an over-long pattern is ignored", () => {
		const robots = parseRobotsTxt(
			`User-agent: *\nDisallow: /${"x".repeat(2100)}\nDisallow: /ok`,
		);
		assertEquals(robots.groups[0].rules.length, 1);
		assertFalse(robots.isAllowed("/ok", UA));
	});

	await t.step("a wildcard bomb does not hang the matcher", () => {
		// the regex spelling of this pattern backtracks exponentially
		const robots = parseRobotsTxt(`User-agent: *\nDisallow: /${"a*".repeat(40)}b`);
		const path = "/" + "a".repeat(4000);
		const started = performance.now();
		assert(robots.isAllowed(path, UA));
		assert(
			performance.now() - started < 1000,
			"matching must not blow up on a star-heavy pattern",
		);
	});

	await t.step("garbage parses to something usable", () => {
		for (
			const input of [
				"",
				" ",
				":",
				"::::",
				"\n\n\n",
				"Disallow",
				"Disallow:",
				"User-agent: *\nDisallow: *",
				"#".repeat(1000),
			]
		) {
			const robots = parseRobotsTxt(input);
			assert(Array.isArray(robots.groups));
			assertEquals(typeof robots.isAllowed("/x", UA), "boolean");
		}
		// deno-lint-ignore no-explicit-any
		assertEquals(parseRobotsTxt(null as any).groups, []);
	});

	await t.step("many distinct user agents do not grow the memo forever", () => {
		const robots = parseRobotsTxt("User-agent: *\nDisallow: /x");
		for (let i = 0; i < 500; i++) assertFalse(robots.isAllowed("/x", `bot-${i}`));
	});
});
