import { assert, assertEquals } from "@std/assert";
import {
	BINARY_EXTENSIONS,
	evaluateScope,
	type ScopeContext,
	type ScopeVerdict,
} from "../src/engine/scope.ts";
import { resolveCrawlOptions } from "../src/options.ts";
import type { ScopeOptions, SkipReason } from "../src/types.ts";

/**
 * `evaluateScope` is the pure prefix of doc 02's twelve-step follow decision, and the
 * order of those steps is part of the contract — a report reader has to be able to
 * conclude something from `skippedByReason`. So most of what is asserted here is not
 * "is this URL followed" but "and for which of the several applicable reasons".
 *
 * The scope options always come through `resolveCrawlOptions`, never hand-built: that
 * way these tests exercise the real default table rather than a copy of it that can
 * drift.
 */

const SEEDS = ["example.com"];

const scopeOf = (scope: ScopeOptions = {}) => resolveCrawlOptions({ scope }).scope;

/** Everything `evaluateScope` needs, except that `scope` is the *sparse* option shape. */
type TestContext = Omit<Partial<ScopeContext>, "scope"> & { scope?: ScopeOptions };

function verdict(to: string, ctx: TestContext = {}): ScopeVerdict {
	const { scope, ...rest } = ctx;
	return evaluateScope(to, {
		seedHosts: SEEDS,
		kind: "internal",
		...rest,
		scope: scopeOf(scope),
	});
}

const reasonFor = (to: string, ctx?: TestContext): SkipReason | "follow" => {
	const v = verdict(to, ctx);
	return v.follow ? "follow" : v.reason;
};

// ------------------------------------------------------------------------------------

Deno.test("evaluateScope: bad-scheme", async (t) => {
	await t.step("the transport is HTTP, so nothing else is followable", () => {
		assertEquals(reasonFor("mailto:a@b.c"), "bad-scheme");
		assertEquals(reasonFor("javascript:void(0)"), "bad-scheme");
		assertEquals(reasonFor("data:text/html,<a href=/x>"), "bad-scheme");
		assertEquals(reasonFor("ftp://example.com/x"), "bad-scheme");
		assertEquals(reasonFor("file:///etc/passwd"), "bad-scheme");
	});

	await t.step("a URL with no host is not fetchable either", () => {
		assertEquals(reasonFor("http://"), "bad-scheme");
	});

	await t.step("an unparsable target is the same answer, never a throw", () => {
		assertEquals(reasonFor("not a url"), "bad-scheme");
		assertEquals(reasonFor(""), "bad-scheme");
		assertEquals(reasonFor("/relative"), "bad-scheme");
	});

	await t.step("http and https both pass", () => {
		assertEquals(reasonFor("http://example.com/x"), "follow");
		assertEquals(reasonFor("https://example.com/x"), "follow");
	});
});

Deno.test("evaluateScope: too-long", async (t) => {
	const long = (n: number) => `https://example.com/${"x".repeat(n)}`;

	await t.step("the default cap is 2048, measured on the whole URL", () => {
		assertEquals(reasonFor(long(2028)), "follow"); // 2048 exactly
		assertEquals(reasonFor(long(2029)), "too-long");
	});

	await t.step("a raised cap is honored", () => {
		assertEquals(reasonFor(long(3000), { scope: { maxUrlLength: 4000 } }), "follow");
	});

	await t.step("length is checked before the host rules", () => {
		// a URL both too long and off-site reports the cheaper reason
		assertEquals(
			reasonFor(`https://elsewhere.org/${"x".repeat(3000)}`, { kind: "external" }),
			"too-long",
		);
	});
});

Deno.test("evaluateScope: private-host", async (t) => {
	await t.step("private hosts are allowed by default", () => {
		assertEquals(reasonFor("http://127.0.0.1/x", { seedHosts: [] }), "follow");
	});

	await t.step("allowPrivateHosts:false is the guard", () => {
		const off = { allowPrivateHosts: false, seedHosts: [] as string[] };
		assertEquals(reasonFor("http://127.0.0.1/x", off), "private-host");
		assertEquals(reasonFor("http://localhost/x", off), "private-host");
		assertEquals(reasonFor("http://10.1.2.3/x", off), "private-host");
		assertEquals(
			reasonFor("http://169.254.169.254/latest/meta-data/", off),
			"private-host",
		);
		assertEquals(reasonFor("http://[::1]/x", off), "private-host");
	});

	await t.step("a public host is unaffected", () => {
		assertEquals(
			reasonFor("https://example.com/x", { allowPrivateHosts: false }),
			"follow",
		);
	});

	await t.step("WHATWG normalization is what makes the string check work", () => {
		// 0x7f.1 and 2130706433 are both spellings of 127.0.0.1, and `URL` has
		// already turned them into it by the time we see the hostname
		const off = { allowPrivateHosts: false, seedHosts: [] as string[] };
		assertEquals(reasonFor("http://0x7f.1/x", off), "private-host");
		assertEquals(reasonFor("http://2130706433/x", off), "private-host");
	});

	await t.step("it is checked before scope, so the reason is never hidden", () => {
		assertEquals(
			reasonFor("http://127.0.0.1/x", {
				allowPrivateHosts: false,
				kind: "external",
			}),
			"private-host",
		);
	});
});

Deno.test("evaluateScope: out-of-scope", async (t) => {
	await t.step("an external edge is not followed by default", () => {
		assertEquals(
			reasonFor("https://elsewhere.org/x", { kind: "external" }),
			"out-of-scope",
		);
	});

	await t.step("allowExternal follows it and expands it", () => {
		const v = verdict("https://elsewhere.org/x", {
			kind: "external",
			scope: { allowExternal: true },
		});
		assertEquals(v, { follow: true, checkOnly: false });
	});

	await t.step("checkExternal follows it as check-only", () => {
		const v = verdict("https://elsewhere.org/x", {
			kind: "external",
			scope: { checkExternal: true },
		});
		assertEquals(v, { follow: true, checkOnly: true });
	});

	await t.step("allowExternal wins over checkExternal", () => {
		const v = verdict("https://elsewhere.org/x", {
			kind: "external",
			scope: { allowExternal: true, checkExternal: true },
		});
		assertEquals(v, { follow: true, checkOnly: false });
	});

	await t.step("the seed host rule is crawl-relative, not referrer-relative", () => {
		// the edge is internal (the referrer was on blog.example.com) but the crawl
		// was seeded at example.com and the default mode is same-host
		assertEquals(
			reasonFor("https://blog.example.com/x", { kind: "internal" }),
			"out-of-scope",
		);
	});

	await t.step("same-site widens it, any widens it further", () => {
		assertEquals(
			reasonFor("https://blog.example.com/x", {
				scope: { subdomains: "same-site" },
			}),
			"follow",
		);
		assertEquals(
			reasonFor("https://elsewhere.org/x", { scope: { subdomains: "same-site" } }),
			"out-of-scope",
		);
		assertEquals(
			reasonFor("https://elsewhere.org/x", { scope: { subdomains: "any" } }),
			"follow",
		);
	});

	await t.step("an injected PSL resolver changes the verdict", () => {
		const ctx = {
			scope: { subdomains: "same-site" as const },
			getRegistrableDomain: (host: string) =>
				host.endsWith(".github.io") ? host : null,
		};
		assertEquals(
			reasonFor("https://alice.github.io/x", {
				...ctx,
				seedHosts: ["bob.github.io"],
			}),
			"out-of-scope",
		);
	});

	await t.step("no seeds means no host restriction", () => {
		assertEquals(reasonFor("https://anywhere.test/x", { seedHosts: [] }), "follow");
	});

	await t.step("pathPrefix narrows the crawl's own site", () => {
		const scope = { pathPrefix: ["/docs", "/api"] };
		assertEquals(reasonFor("https://example.com/docs/x", { scope }), "follow");
		assertEquals(reasonFor("https://example.com/api", { scope }), "follow");
		assertEquals(reasonFor("https://example.com/blog/x", { scope }), "out-of-scope");
	});

	await t.step("a single pathPrefix string is accepted", () => {
		assertEquals(
			reasonFor("https://example.com/docs/x", { scope: { pathPrefix: "/docs" } }),
			"follow",
		);
	});

	await t.step("pathPrefix does NOT filter externals — checkExternal would die", () => {
		assertEquals(
			reasonFor("https://elsewhere.org/anything", {
				kind: "external",
				scope: { pathPrefix: "/docs", checkExternal: true },
			}),
			"follow",
		);
	});
});

Deno.test("evaluateScope: excluded", async (t) => {
	await t.step("a string pattern is a substring of the absolute URL", () => {
		assertEquals(
			reasonFor("https://example.com/x?print=1", {
				scope: { exclude: ["?print="] },
			}),
			"excluded",
		);
		assertEquals(
			reasonFor("https://example.com/x", { scope: { exclude: ["?print="] } }),
			"follow",
		);
	});

	await t.step("a RegExp pattern is tested against it", () => {
		assertEquals(
			reasonFor("https://example.com/tag/42", {
				scope: { exclude: [/\/tag\/\d+/] },
			}),
			"excluded",
		);
	});

	await t.step("a /g pattern does not skip every other URL", () => {
		// a global RegExp carries lastIndex between .test() calls; without the guard
		// this alternates between excluded and followed
		const scope = { exclude: [/x/g] };
		assertEquals(reasonFor("https://example.com/x", { scope }), "excluded");
		assertEquals(reasonFor("https://example.com/x", { scope }), "excluded");
		assertEquals(reasonFor("https://example.com/x", { scope }), "excluded");
	});

	await t.step("an include miss reports excluded, not out-of-scope", () => {
		const scope = { include: ["/docs/"] };
		assertEquals(reasonFor("https://example.com/docs/x", { scope }), "follow");
		assertEquals(reasonFor("https://example.com/blog/x", { scope }), "excluded");
	});

	await t.step("exclude wins over include", () => {
		const scope = { include: ["/docs/"], exclude: ["/docs/private/"] };
		assertEquals(reasonFor("https://example.com/docs/x", { scope }), "follow");
		assertEquals(
			reasonFor("https://example.com/docs/private/x", { scope }),
			"excluded",
		);
	});

	await t.step("an empty pattern contributes nothing", () => {
		// `"".includes("")` is true, so a stray empty entry would otherwise exclude
		// the entire web — a split-an-env-var accident with no error message
		assertEquals(
			reasonFor("https://example.com/x", { scope: { exclude: [""] } }),
			"follow",
		);
		assertEquals(
			reasonFor("https://example.com/x", { scope: { include: ["", "/nope"] } }),
			"excluded",
		);
	});

	await t.step("exclude applies to externals, include does not", () => {
		assertEquals(
			reasonFor("https://elsewhere.org/bad", {
				kind: "external",
				scope: { checkExternal: true, exclude: ["/bad"] },
			}),
			"excluded",
		);
		assertEquals(
			reasonFor("https://elsewhere.org/x", {
				kind: "external",
				scope: { checkExternal: true, include: ["/docs/"] },
			}),
			"follow",
		);
	});
});

Deno.test("evaluateScope: nofollow", async (t) => {
	await t.step("a nofollow link is skipped by default", () => {
		assertEquals(
			reasonFor("https://example.com/x", { nofollow: true }),
			"nofollow",
		);
	});

	await t.step("followNofollow overrides it", () => {
		assertEquals(
			reasonFor("https://example.com/x", {
				nofollow: true,
				scope: { followNofollow: true },
			}),
			"follow",
		);
	});

	await t.step("scope beats nofollow — the cheaper reason is reported", () => {
		assertEquals(
			reasonFor("https://elsewhere.org/x", { nofollow: true, kind: "external" }),
			"out-of-scope",
		);
	});
});

Deno.test("evaluateScope: out-of-region", async (t) => {
	const scope: ScopeOptions = { followRegions: ["main", "article"] };

	await t.step("a listed region is followed", () => {
		assertEquals(
			reasonFor("https://example.com/x", { scope: { ...scope }, region: "main" }),
			"follow",
		);
		assertEquals(
			reasonFor("https://example.com/x", {
				scope: { ...scope },
				region: "article",
			}),
			"follow",
		);
	});

	await t.step("an unlisted region is not", () => {
		assertEquals(
			reasonFor("https://example.com/x", { scope: { ...scope }, region: "nav" }),
			"out-of-region",
		);
		assertEquals(
			reasonFor("https://example.com/x", { scope: { ...scope }, region: "footer" }),
			"out-of-region",
		);
	});

	await t.step("a link with no region is not, either — while the page has some", () => {
		assertEquals(
			reasonFor("https://example.com/x", {
				scope: { ...scope },
				regionsPresent: true,
			}),
			"out-of-region",
		);
	});

	await t.step("the whole-document fallback exempts a landmark-free page", () => {
		assertEquals(
			reasonFor("https://example.com/x", {
				scope: { ...scope },
				regionsPresent: false,
			}),
			"follow",
		);
	});

	await t.step("omitting regionsPresent does not silently disable filtering", () => {
		assertEquals(
			reasonFor("https://example.com/x", { scope: { ...scope }, region: "nav" }),
			"out-of-region",
		);
	});

	await t.step("an empty followRegions is off, which is the default", () => {
		assertEquals(
			reasonFor("https://example.com/x", { region: "footer" }),
			"follow",
		);
	});
});

Deno.test("evaluateScope: unsupported-type", async (t) => {
	await t.step("obvious binaries are not pages", () => {
		for (const path of ["/a.zip", "/a.png", "/a.mp4", "/f.woff2", "/i.SVG"]) {
			assertEquals(
				reasonFor(`https://example.com${path}`),
				"unsupported-type",
				path,
			);
		}
	});

	await t.step("documents are, deliberately", () => {
		for (const path of ["/a.pdf", "/a.csv", "/a.json", "/a.xml", "/a.html", "/a"]) {
			assertEquals(reasonFor(`https://example.com${path}`), "follow", path);
		}
	});

	await t.step("the query is not part of the extension", () => {
		assertEquals(reasonFor("https://example.com/x?f=a.zip"), "follow");
		assertEquals(reasonFor("https://example.com/a.zip?v=2"), "unsupported-type");
	});

	await t.step("a dotfile has no extension", () => {
		assertEquals(reasonFor("https://example.com/.gitignore"), "follow");
	});

	await t.step("a multi-part name uses the last extension", () => {
		assertEquals(reasonFor("https://example.com/a.tar.gz"), "unsupported-type");
		assertEquals(reasonFor("https://example.com/a.zip.html"), "follow");
	});

	await t.step("opt-in sources are exempt — the caller asked for exactly those", () => {
		assertEquals(reasonFor("https://example.com/a.png", { rel: "asset" }), "follow");
		assertEquals(reasonFor("https://example.com/a.mp4", { rel: "iframe" }), "follow");
		assertEquals(
			reasonFor("https://example.com/a.zip", { rel: "alternate" }),
			"follow",
		);
	});

	await t.step("document rels are not exempt", () => {
		for (const rel of ["page", "canonical", "next", "prev", "sitemap"] as const) {
			assertEquals(
				reasonFor("https://example.com/a.zip", { rel }),
				"unsupported-type",
				rel,
			);
		}
	});

	await t.step("a check-only external is exempt — it is never downloaded", () => {
		assertEquals(
			reasonFor("https://elsewhere.org/big.mkv", {
				kind: "external",
				scope: { checkExternal: true },
			}),
			"follow",
		);
		// but a fully crawled external is not
		assertEquals(
			reasonFor("https://elsewhere.org/big.mkv", {
				kind: "external",
				scope: { allowExternal: true },
			}),
			"unsupported-type",
		);
	});

	await t.step("the deny-list is images, archives, media and fonts only", () => {
		assert(BINARY_EXTENSIONS.has("jpg"));
		assert(BINARY_EXTENSIONS.has("woff2"));
		assert(!BINARY_EXTENSIONS.has("pdf"));
		assert(!BINARY_EXTENSIONS.has("html"));
		assert([...BINARY_EXTENSIONS].every((e) => e === e.toLowerCase()));
	});
});

Deno.test("evaluateScope: the order is the contract", async (t) => {
	await t.step("first hit wins, all the way down", () => {
		// one URL that trips every check at once; peel them off one at a time and the
		// reported reason walks the documented order
		const url = `https://elsewhere.org/nav/${"x".repeat(3000)}.zip`;
		const base: TestContext = {
			kind: "external",
			nofollow: true,
			region: "nav",
			allowPrivateHosts: false,
		};
		const scope: ScopeOptions = {
			allowExternal: true,
			exclude: ["/nav/"],
			followRegions: ["main"],
		};

		assertEquals(reasonFor(url, { ...base, scope }), "too-long");
		const fits = "https://elsewhere.org/nav/a.zip";
		assertEquals(reasonFor(fits, { ...base, scope }), "excluded");
		assertEquals(
			reasonFor(fits, { ...base, scope: { ...scope, exclude: [] } }),
			"nofollow",
		);
		assertEquals(
			reasonFor(fits, {
				...base,
				nofollow: false,
				scope: { ...scope, exclude: [] },
			}),
			"out-of-region",
		);
		assertEquals(
			reasonFor(fits, {
				...base,
				nofollow: false,
				scope: { ...scope, exclude: [], followRegions: [] },
			}),
			"unsupported-type",
		);
		assertEquals(
			reasonFor("https://elsewhere.org/nav/a.html", {
				...base,
				nofollow: false,
				scope: { ...scope, exclude: [], followRegions: [] },
			}),
			"follow",
		);
	});

	await t.step("out-of-scope precedes excluded", () => {
		assertEquals(
			reasonFor("https://elsewhere.org/bad", {
				kind: "external",
				scope: { exclude: ["/bad"] },
			}),
			"out-of-scope",
		);
	});
});

Deno.test("evaluateScope: it accepts a URL as cheaply as a string", async (t) => {
	await t.step("both spellings agree", () => {
		const url = new URL("https://example.com/x");
		assertEquals(
			evaluateScope(url, { seedHosts: SEEDS, scope: scopeOf(), kind: "internal" }),
			verdict("https://example.com/x"),
		);
	});

	await t.step("verdicts are shared frozen values, not fresh objects", () => {
		// this runs once per extracted link; there is nothing to allocate
		const a = verdict("mailto:x@y.z");
		const b = verdict("javascript:0");
		assert(a === b);
		assert(Object.isFrozen(a));
		assert(Object.isFrozen(verdict("https://example.com/x")));
	});
});
