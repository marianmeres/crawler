import { assert, assertEquals } from "@std/assert";
import {
	canonPercentEncoding,
	DEFAULT_STRIP_PARAMS,
	type NormalizeOptions,
	normalizeUrl,
} from "../../src/url/normalize-url.ts";
import corpus from "../fixtures/urls/normalize-cases.json" with { type: "json" };

interface Case {
	group: string;
	name: string;
	input: string;
	base?: string | null;
	opts?: NormalizeOptions;
	expected: string | null;
}

/**
 * Asserts the expected value AND — for every non-null result — that re-normalizing it
 * under the same options changes nothing. Idempotency is a required property of
 * `normalizeUrl`, so every single case in the suite pays for it.
 */
function assertNormalized(
	input: string,
	expected: string | null,
	opts?: NormalizeOptions,
	base?: string,
) {
	const actual = normalizeUrl(input, base, opts);
	assertEquals(actual, expected, `normalizeUrl(${JSON.stringify(input)})`);
	if (actual !== null) {
		assertEquals(
			normalizeUrl(actual, undefined, opts),
			actual,
			`not idempotent: ${actual}`,
		);
	}
}

// ---------------------------------------------------------------------------------
// Table-driven corpus (tests/fixtures/urls/normalize-cases.json), one Deno.test per
// group. The fixture is a static JSON import on purpose: it needs no --allow-read, so
// the ./url suite runs standalone under a bare `deno test`.
// ---------------------------------------------------------------------------------

const cases = corpus.cases as Case[];
const groups = [...new Set(cases.map((c) => c.group))];

for (const group of groups) {
	Deno.test(`normalizeUrl corpus: ${group}`, async (t) => {
		for (const c of cases.filter((x) => x.group === group)) {
			await t.step(c.name, () => {
				assertNormalized(c.input, c.expected, c.opts, c.base ?? undefined);
			});
		}
	});
}

Deno.test("normalizeUrl corpus: is not silently empty", () => {
	assertEquals(cases.length > 100, true, `only ${cases.length} corpus cases`);
	assertEquals(groups.length > 5, true, `only ${groups.length} corpus groups`);
});

// ---------------------------------------------------------------------------------
// Cases a JSON table cannot carry.
// ---------------------------------------------------------------------------------

Deno.test("DEFAULT_STRIP_PARAMS: contents are pinned", () => {
	// Written out rather than derived from the array under test: this list IS the
	// dedup contract, so removing an entry has to be a visible, deliberate edit.
	assertEquals(
		DEFAULT_STRIP_PARAMS.map((p) => (typeof p === "string" ? p : String(p))),
		[
			"/^utm_/i",
			"fbclid",
			"gclid",
			"dclid",
			"gbraid",
			"wbraid",
			"msclkid",
			"mc_cid",
			"mc_eid",
			"_ga",
			"_gl",
			"ref",
			"igshid",
			"spm",
			"/^(phpsessid|jsessionid|sessionid|session_id|sid)$/i",
		],
	);
});

Deno.test("normalizeUrl: every default-blocklist name is actually stripped", () => {
	for (
		const name of [
			"utm_source",
			"utm_medium",
			"UTM_CAMPAIGN",
			"fbclid",
			"gclid",
			"dclid",
			"gbraid",
			"wbraid",
			"msclkid",
			"mc_cid",
			"mc_eid",
			"_ga",
			"_gl",
			"ref",
			"igshid",
			"spm",
			"PHPSESSID",
			"jsessionid",
			"sessionid",
			"session_id",
			"sid",
		]
	) {
		assertNormalized(`https://a.com/x?${name}=v&keep=1`, "https://a.com/x?keep=1");
	}
});

Deno.test("normalizeUrl: stripParams accepts RegExp", async (t) => {
	await t.step("a plain pattern", () => {
		assertNormalized("https://a.com/x?tk_a=1&b=2", "https://a.com/x?b=2", {
			stripParams: [/^tk_/],
		});
	});
	await t.step("a global pattern does not skip alternate matches", () => {
		// /g patterns carry lastIndex between .test() calls unless reset
		assertNormalized("https://a.com/x?tk=1&tk=2&tk=3&b=4", "https://a.com/x?b=4", {
			stripParams: [/tk/g],
		});
	});
	await t.step("mixed strings and patterns", () => {
		assertNormalized("https://a.com/x?a=1&tk_b=2&c=3", "https://a.com/x?c=3", {
			stripParams: ["a", /^tk_/],
		});
	});
});

Deno.test("normalizeUrl: length cap", async (t) => {
	const long = "https://a.com/" + "x".repeat(3000);
	await t.step("rejects over the default 2048", () => {
		assertNormalized(long, null);
	});
	await t.step("respects a raised cap", () => {
		assertEquals(normalizeUrl(long, undefined, { maxLength: 4000 }), long);
	});
	await t.step("measures the normalized string, not the input", () => {
		// 40 chars of tracking params disappear before the cap is applied
		assertNormalized(
			"https://a.com/x?utm_source=aaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			"https://a.com/x",
			{ maxLength: 20 },
		);
	});
});

Deno.test("normalizeUrl: non-string input yields null", () => {
	for (const bad of [null, undefined, 42, {}, [], true]) {
		assertEquals(normalizeUrl(bad as unknown as string), null);
	}
});

Deno.test("normalizeUrl: options object may be null/undefined", () => {
	assertEquals(
		normalizeUrl("https://a.com/x", undefined, undefined),
		"https://a.com/x",
	);
	assertEquals(
		normalizeUrl("https://a.com/x", undefined, null as unknown as NormalizeOptions),
		"https://a.com/x",
	);
});

Deno.test("canonPercentEncoding: is a fixed point", () => {
	for (
		const s of [
			"/a%2",
			"/%7e",
			"/%zz",
			"/100%",
			"/%C3%A9",
			"/plain",
			"",
			"%",
			"%%%",
			"/%2f%2F",
		]
	) {
		const once = canonPercentEncoding(s);
		assertEquals(canonPercentEncoding(once), once, `not a fixed point: ${s}`);
	}
});

Deno.test("normalizeUrl: a hostile slash run stays linear", () => {
	// `/\/+$/` backtracks quadratically on a long slash run that does not end in a
	// slash; at 200k slashes that was ~20s of blocked event loop per hostile href.
	const hostile = "https://a.com/" + "/".repeat(200_000) + "x";
	const started = performance.now();
	const out = normalizeUrl(hostile, undefined, {
		collapseSlashes: false,
		maxLength: 1_000_000,
	});
	const elapsed = performance.now() - started;
	assertEquals(out !== null, true);
	assert(
		elapsed < 2000,
		`took ${elapsed.toFixed(0)}ms — the trailing-slash scan is backtracking again`,
	);
});
