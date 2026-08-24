import { assertEquals } from "@std/assert";
import {
	canonPercentEncoding,
	DEFAULT_STRIP_PARAMS,
	type NormalizeOptions,
	normalizeUrl,
} from "../../src/url/normalize-url.ts";

/** Asserts the expected value AND that re-normalizing it is a no-op. */
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

Deno.test("normalizeUrl: WHATWG-inherent canonicalization", async (t) => {
	await t.step("lowercases scheme and host", () => {
		assertNormalized("HTTPS://Ex.COM/A", "https://ex.com/A");
	});
	await t.step("punycodes IDN hosts", () => {
		assertNormalized("https://MÜNCHEN.de/", "https://xn--mnchen-3ya.de/");
	});
	await t.step("strips default ports, keeps others", () => {
		assertNormalized("http://a.com:80/x", "http://a.com/x");
		assertNormalized("https://a.com:443/x", "https://a.com/x");
		assertNormalized("https://a.com:8080/x", "https://a.com:8080/x");
	});
	await t.step("resolves dot segments (literal and %2e-encoded)", () => {
		assertNormalized("https://a.com/a/b/../../c/./d", "https://a.com/c/d");
		assertNormalized("https://a.com/a/%2e%2e/b", "https://a.com/b");
	});
	await t.step("root path is materialized", () => {
		assertNormalized("https://a.com", "https://a.com/");
	});
});

Deno.test("normalizeUrl: scheme gate", async (t) => {
	await t.step("rejects non-http(s) schemes", () => {
		for (
			const u of [
				"mailto:a@b.com",
				"tel:+421900000000",
				"javascript:alert(1)",
				"data:text/plain,hi",
				"blob:https://a.com/uuid",
				"sms:+421900000000",
				"ftp://a.com/x",
				"about:blank",
				"ws://a.com/x",
			]
		) {
			assertNormalized(u, null);
		}
	});
	await t.step("allow-list can be widened, colon optional", () => {
		assertNormalized("ftp://a.com/x", "ftp://a.com/x", {
			allowSchemes: ["ftp"],
		});
		assertNormalized("FTP://A.com/x", "ftp://a.com/x", {
			allowSchemes: ["FTP:"],
		});
	});
	await t.step("widening does not smuggle in http", () => {
		assertNormalized("https://a.com/x", null, { allowSchemes: ["ftp:"] });
	});
});

Deno.test("normalizeUrl: fragment policy", async (t) => {
	await t.step("strips by default", () => {
		assertNormalized("https://a.com/x#top", "https://a.com/x");
	});
	await t.step("keeps when disabled", () => {
		assertNormalized("https://a.com/x#top", "https://a.com/x#top", {
			stripFragment: false,
		});
	});
	await t.step("keepHashbang keeps only #!", () => {
		const opts: NormalizeOptions = { keepHashbang: true };
		assertNormalized(
			"https://a.com/x#!/route",
			"https://a.com/x#!/route",
			opts,
		);
		assertNormalized("https://a.com/x#top", "https://a.com/x", opts);
	});
	await t.step("empty fragment never survives", () => {
		assertNormalized("https://a.com/x#", "https://a.com/x", {
			stripFragment: false,
		});
	});
});

Deno.test("normalizeUrl: percent-encoding canonicalization", async (t) => {
	await t.step("decodes unreserved bytes", () => {
		assertNormalized(
			"https://a.com/%7Ex%2Dy%5Fz%2Ew",
			"https://a.com/~x-y_z.w",
		);
	});
	await t.step("uppercases other triplets", () => {
		assertNormalized("https://a.com/a%2fb%3ac", "https://a.com/a%2Fb%3Ac");
	});
	await t.step("keeps multi-byte sequences encoded", () => {
		assertNormalized("https://a.com/%c3%a9", "https://a.com/%C3%A9");
		assertNormalized("https://a.com/é", "https://a.com/%C3%A9");
	});
	await t.step("repairs stray percent signs", () => {
		assertNormalized("https://a.com/100%", "https://a.com/100%25");
		assertNormalized("https://a.com/a%2", "https://a.com/a%252");
		assertNormalized("https://a.com/a%zz", "https://a.com/a%25zz");
	});
	await t.step("can be disabled", () => {
		assertNormalized("https://a.com/%7Ex%2fy", "https://a.com/%7Ex%2fy", {
			normalizeEncoding: false,
		});
	});
	await t.step("canonPercentEncoding is a fixed point", () => {
		for (const s of ["/a%2", "/%7e", "/%zz", "/100%", "/%C3%A9", "/plain"]) {
			const once = canonPercentEncoding(s);
			assertEquals(canonPercentEncoding(once), once);
		}
	});
});

Deno.test("normalizeUrl: path shape", async (t) => {
	await t.step("collapses slash runs", () => {
		assertNormalized("https://a.com//a///b", "https://a.com/a/b");
	});
	await t.step("collapsing can be disabled", () => {
		assertNormalized("https://a.com//a///b", "https://a.com//a///b", {
			collapseSlashes: false,
		});
	});
	await t.step("never collapses an encoded slash", () => {
		assertNormalized("https://a.com/a%2F%2Fb", "https://a.com/a%2F%2Fb");
	});
	await t.step("strips trailing slashes but never the root", () => {
		assertNormalized("https://a.com/dir/", "https://a.com/dir");
		assertNormalized("https://a.com/", "https://a.com/");
		assertNormalized("https://a.com//", "https://a.com/");
		assertNormalized("https://a.com/dir/?a=1", "https://a.com/dir?a=1");
	});
	await t.step("trailing slash can be kept", () => {
		assertNormalized("https://a.com/dir/", "https://a.com/dir/", {
			trailingSlash: "keep",
		});
	});
	await t.step("multiple trailing slashes settle in one pass", () => {
		assertNormalized("https://a.com/dir///", "https://a.com/dir", {
			collapseSlashes: false,
		});
	});
});

Deno.test("normalizeUrl: query policy", async (t) => {
	await t.step("strips tracking params and sorts the rest", () => {
		assertNormalized(
			"https://Ex.com/a?utm_source=x&b=2&a=1",
			"https://ex.com/a?a=1&b=2",
		);
	});
	await t.step("covers the whole default blocklist", () => {
		for (const p of DEFAULT_STRIP_PARAMS) {
			const name = typeof p === "string"
				? p
				: p.source.includes("utm_")
				? "utm_medium"
				: "PHPSESSID";
			assertNormalized(
				`https://a.com/x?${name}=v&keep=1`,
				"https://a.com/x?keep=1",
			);
		}
	});
	await t.step("strip matching is case-insensitive for strings", () => {
		assertNormalized("https://a.com/x?FBCLID=1", "https://a.com/x");
	});
	await t.step("sorting is stable for repeated names", () => {
		assertNormalized(
			"https://a.com/x?b=1&a=2&a=1",
			"https://a.com/x?a=2&a=1&b=1",
		);
	});
	await t.step("sorting can be disabled", () => {
		assertNormalized("https://a.com/x?b=1&a=2", "https://a.com/x?b=1&a=2", {
			sortParams: false,
		});
	});
	await t.step("empty params kept by default, dropped on request", () => {
		assertNormalized("https://a.com/x?a=&b=1", "https://a.com/x?a=&b=1");
		assertNormalized("https://a.com/x?a=&b=1", "https://a.com/x?b=1", {
			stripEmptyParams: true,
		});
	});
	await t.step("an empty query loses its question mark", () => {
		assertNormalized("https://a.com/x?", "https://a.com/x");
		assertNormalized("https://a.com/x?utm_source=x", "https://a.com/x");
	});
	await t.step("spaces canonicalize to +", () => {
		assertNormalized(
			"https://a.com/x?q=a b&r=c%20d",
			"https://a.com/x?q=a+b&r=c+d",
		);
	});
	await t.step("raw query survives when normalizeQuery is off", () => {
		assertNormalized(
			"https://a.com/x?utm_source=1&b=2&a=1",
			"https://a.com/x?utm_source=1&b=2&a=1",
			{ normalizeQuery: false },
		);
	});
	await t.step("custom stripParams accept RegExp", () => {
		assertNormalized("https://a.com/x?tk_a=1&b=2", "https://a.com/x?b=2", {
			stripParams: [/^tk_/],
		});
	});
	await t.step("a global RegExp does not skip alternate matches", () => {
		assertNormalized("https://a.com/x?tk=1&tk=2&b=3", "https://a.com/x?b=3", {
			stripParams: [/tk/g],
		});
	});
});

Deno.test("normalizeUrl: www policy", async (t) => {
	await t.step("kept by default", () => {
		assertNormalized("https://www.a.com/x", "https://www.a.com/x");
	});
	await t.step("stripped on request", () => {
		assertNormalized("https://www.a.com/x", "https://a.com/x", {
			stripWww: true,
		});
	});
	await t.step("never strips down to a single label", () => {
		assertNormalized("https://www.com/x", "https://www.com/x", {
			stripWww: true,
		});
	});
	await t.step("strips repeated leading labels (stays a fixed point)", () => {
		assertNormalized("https://www.www.a.com/x", "https://a.com/x", {
			stripWww: true,
		});
	});
});

Deno.test("normalizeUrl: base resolution", async (t) => {
	await t.step("resolves relative references", () => {
		assertNormalized(
			"../b?x=1#f",
			"https://ex.com/p/b?x=1",
			undefined,
			"https://ex.com/p/q/r",
		);
		assertNormalized(
			"/abs",
			"https://ex.com/abs",
			undefined,
			"https://ex.com/p/q",
		);
		assertNormalized(
			"//other.com/x",
			"https://other.com/x",
			undefined,
			"https://ex.com/p",
		);
	});
	await t.step("never guesses a scheme", () => {
		assertNormalized("example.com/x", null);
	});
	await t.step("a blank base behaves like no base", () => {
		assertNormalized("https://a.com/x", "https://a.com/x", undefined, "");
		assertNormalized("/x", null, undefined, "   ");
	});
	await t.step("an unparsable base yields null", () => {
		assertNormalized("/x", null, undefined, "not a url");
	});
});

Deno.test("normalizeUrl: rejections", async (t) => {
	await t.step("empty and blank input", () => {
		assertNormalized("", null);
		assertNormalized("   ", null);
	});
	await t.step("garbage input", () => {
		assertNormalized("http://", null);
		assertNormalized(":::", null);
	});
	await t.step("over-length input", () => {
		const long = "https://a.com/" + "x".repeat(3000);
		assertNormalized(long, null);
		assertEquals(normalizeUrl(long, undefined, { maxLength: 4000 }), long);
	});
	await t.step("non-string input", () => {
		assertEquals(normalizeUrl(null as unknown as string), null);
		assertEquals(normalizeUrl(undefined as unknown as string), null);
	});
});

Deno.test("normalizeUrl: userinfo is preserved verbatim", async (t) => {
	await t.step("user and password", () => {
		assertNormalized("https://user:pass@a.com/x", "https://user:pass@a.com/x");
	});
	await t.step("user only", () => {
		assertNormalized("https://user@a.com/x", "https://user@a.com/x");
	});
	await t.step("password only", () => {
		assertNormalized("https://:pass@a.com/x", "https://:pass@a.com/x");
	});
});

Deno.test("normalizeUrl: input is trimmed and control chars removed", () => {
	assertNormalized("  https://a.com/x  ", "https://a.com/x");
	assertNormalized("https://a.com/x\ty\nz", "https://a.com/xyz");
});
