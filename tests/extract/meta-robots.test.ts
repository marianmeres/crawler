import { assertEquals } from "@std/assert";
import { parseMetaRobots, parseXRobotsTag } from "../../src/extract/mod.ts";

const NOTHING = { noindex: false, nofollow: false, raw: [] };

Deno.test("parseMetaRobots", async (t) => {
	await t.step("the documented tag", () => {
		assertEquals(
			parseMetaRobots(`<meta name="robots" content="noindex, nofollow">`),
			{
				noindex: true,
				nofollow: true,
				raw: ["noindex", "nofollow"],
			},
		);
	});

	await t.step("name and content are both case-insensitive", () => {
		assertEquals(parseMetaRobots(`<meta name="ROBOTS" content="NoIndex">`), {
			noindex: true,
			nofollow: false,
			raw: ["noindex"],
		});
	});

	await t.step("none is both, all is neither", () => {
		assertEquals(parseMetaRobots(`<meta name="robots" content="none">`), {
			noindex: true,
			nofollow: true,
			raw: ["none"],
		});
		assertEquals(parseMetaRobots(`<meta name="robots" content="all">`), {
			noindex: false,
			nofollow: false,
			raw: ["all"],
		});
	});

	await t.step("several tags merge, most restrictive wins", () => {
		assertEquals(
			parseMetaRobots(
				`<meta name="robots" content="all">` +
					`<meta name="robots" content="noindex">` +
					`<meta name="robots" content="nofollow">`,
			),
			{ noindex: true, nofollow: true, raw: ["all", "noindex", "nofollow"] },
		);
	});

	await t.step("unknown tokens are recorded, deduped, in order", () => {
		assertEquals(
			parseMetaRobots(
				`<meta name="robots" content="noarchive, nosnippet , noarchive">` +
					`<meta name="robots" content="max-snippet:-1">`,
			),
			{
				noindex: false,
				nofollow: false,
				raw: ["noarchive", "nosnippet", "max-snippet:-1"],
			},
		);
	});

	await t.step("only the addressed names count", () => {
		const html = `<meta name="robots" content="noindex">` +
			`<meta name="googlebot" content="nofollow">` +
			`<meta name="description" content="none">`;
		assertEquals(parseMetaRobots(html), {
			noindex: true,
			nofollow: false,
			raw: ["noindex"],
		});
		assertEquals(parseMetaRobots(html, { names: ["googlebot"] }), {
			noindex: false,
			nofollow: true,
			raw: ["nofollow"],
		});
		assertEquals(
			parseMetaRobots(html, { names: ["robots", "GoogleBot"] }),
			{ noindex: true, nofollow: true, raw: ["noindex", "nofollow"] },
		);
	});

	await t.step("an empty names list addresses nothing", () => {
		assertEquals(
			parseMetaRobots(`<meta name="robots" content="noindex">`, { names: [] }),
			NOTHING,
		);
	});

	await t.step("a meta inside a script or a comment is not a directive", () => {
		assertEquals(
			parseMetaRobots(
				`<script>var s = '<meta name="robots" content="noindex">';</script>` +
					`<!-- <meta name="robots" content="none"> -->`,
			),
			NOTHING,
		);
	});

	await t.step("attribute soup is tolerated", () => {
		assertEquals(
			parseMetaRobots(`<META NAME=robots CONTENT='noindex , nofollow' >`),
			{ noindex: true, nofollow: true, raw: ["noindex", "nofollow"] },
		);
	});

	await t.step("a tag with no usable content contributes nothing", () => {
		assertEquals(parseMetaRobots(`<meta name="robots">`), NOTHING);
		assertEquals(parseMetaRobots(`<meta name="robots" content="">`), NOTHING);
		assertEquals(parseMetaRobots(`<meta name="robots" content="  ,  ">`), NOTHING);
	});

	await t.step("no input, no directives — and never a throw", () => {
		assertEquals(parseMetaRobots(``), NOTHING);
		assertEquals(parseMetaRobots(`<html><body>nothing here`), NOTHING);
		// deno-lint-ignore no-explicit-any
		assertEquals(parseMetaRobots(null as any), NOTHING);
		assertEquals(parseMetaRobots(`<meta name="robots" content="`), NOTHING);
	});
});

Deno.test("parseXRobotsTag", async (t) => {
	await t.step("an unscoped value applies to everyone", () => {
		assertEquals(parseXRobotsTag("noindex, nofollow"), {
			noindex: true,
			nofollow: true,
			raw: ["noindex", "nofollow"],
		});
		assertEquals(parseXRobotsTag("NOINDEX", { botName: "mybot" }), {
			noindex: true,
			nofollow: false,
			raw: ["noindex"],
		});
	});

	await t.step("a scoped group applies only to the bot it names", () => {
		assertEquals(
			parseXRobotsTag("googlebot: noindex", { botName: "mybot" }),
			NOTHING,
		);
		assertEquals(parseXRobotsTag("mybot: noindex", { botName: "mybot" }), {
			noindex: true,
			nofollow: false,
			raw: ["noindex"],
		});
	});

	await t.step("scope matching is case-insensitive and token-in-name", () => {
		assertEquals(
			parseXRobotsTag("MyBot: nofollow", { botName: "mybot/1.0 (+https://x)" }),
			{ noindex: false, nofollow: true, raw: ["nofollow"] },
		);
	});

	await t.step("with no botName, only unscoped directives apply", () => {
		assertEquals(parseXRobotsTag("noindex, mybot: nofollow"), {
			noindex: true,
			nofollow: false,
			raw: ["noindex"],
		});
	});

	await t.step("a group runs until the next one starts", () => {
		const header = "googlebot: nofollow, otherbot: noindex, nosnippet";
		assertEquals(parseXRobotsTag(header, { botName: "otherbot" }), {
			noindex: true,
			nofollow: false,
			raw: ["noindex", "nosnippet"],
		});
		assertEquals(parseXRobotsTag(header, { botName: "googlebot" }), {
			noindex: false,
			nofollow: true,
			raw: ["nofollow"],
		});
		assertEquals(parseXRobotsTag(header, { botName: "thirdbot" }), NOTHING);
	});

	await t.step("repeated headers arrive comma-joined", () => {
		assertEquals(parseXRobotsTag("noindex, mybot: nofollow", { botName: "mybot" }), {
			noindex: true,
			nofollow: true,
			raw: ["noindex", "nofollow"],
		});
	});

	await t.step("valued directives are directives, not group names", () => {
		assertEquals(
			parseXRobotsTag("unavailable_after: 25 Jun 2010 15:00:00 PST, noindex"),
			{
				noindex: true,
				nofollow: false,
				raw: ["unavailable_after: 25 jun 2010 15:00:00 pst", "noindex"],
			},
		);
		assertEquals(
			parseXRobotsTag("max-snippet:-1, max-image-preview:large, nofollow"),
			{
				noindex: false,
				nofollow: true,
				raw: ["max-snippet:-1", "max-image-preview:large", "nofollow"],
			},
		);
	});

	await t.step("none and all behave as in the meta tag", () => {
		assertEquals(parseXRobotsTag("none"), {
			noindex: true,
			nofollow: true,
			raw: ["none"],
		});
		assertEquals(parseXRobotsTag("all"), {
			noindex: false,
			nofollow: false,
			raw: ["all"],
		});
	});

	await t.step("empty, missing and malformed values are all-false", () => {
		assertEquals(parseXRobotsTag(""), NOTHING);
		assertEquals(parseXRobotsTag("   "), NOTHING);
		assertEquals(parseXRobotsTag(null), NOTHING);
		assertEquals(parseXRobotsTag(undefined), NOTHING);
		assertEquals(parseXRobotsTag(",,,"), NOTHING);
		assertEquals(parseXRobotsTag(":"), NOTHING);
		assertEquals(parseXRobotsTag(": noindex"), NOTHING);
		// deno-lint-ignore no-explicit-any
		assertEquals(parseXRobotsTag(42 as any), NOTHING);
	});

	await t.step("an empty group name never matches", () => {
		assertEquals(parseXRobotsTag(": noindex", { botName: "mybot" }), NOTHING);
	});
});
