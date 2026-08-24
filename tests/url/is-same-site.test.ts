import { assert, assertEquals, assertFalse } from "@std/assert";
import {
	classifyLink,
	getRegistrableDomain,
	hostsAreSameSite,
	isSameSite,
	SECOND_LEVEL_LABELS,
} from "../../src/url/same-site.ts";

Deno.test("getRegistrableDomain: ordinary hosts", async (t) => {
	await t.step("two-label hosts are their own registrable domain", () => {
		assertEquals(getRegistrableDomain("example.com"), "example.com");
		assertEquals(getRegistrableDomain("example.sk"), "example.sk");
	});
	await t.step("subdomains collapse to the registrable domain", () => {
		assertEquals(getRegistrableDomain("blog.example.com"), "example.com");
		assertEquals(getRegistrableDomain("a.b.c.example.com"), "example.com");
	});
	await t.step("long TLDs are not mistaken for ccTLDs", () => {
		assertEquals(getRegistrableDomain("shop.example.info"), "example.info");
		assertEquals(getRegistrableDomain("a.example.museum"), "example.museum");
	});
});

Deno.test("getRegistrableDomain: multi-label public suffixes", async (t) => {
	await t.step("<second-level>.<ccTLD> needs three labels", () => {
		assertEquals(getRegistrableDomain("example.co.uk"), "example.co.uk");
		assertEquals(getRegistrableDomain("www.example.co.uk"), "example.co.uk");
		assertEquals(getRegistrableDomain("shop.example.com.au"), "example.com.au");
		assertEquals(getRegistrableDomain("minv.gov.sk"), "minv.gov.sk");
		assertEquals(getRegistrableDomain("www.minv.gov.sk"), "minv.gov.sk");
		assertEquals(getRegistrableDomain("a.b.example.co.jp"), "example.co.jp");
	});
	await t.step("a bare public suffix has no registrable domain", () => {
		assertEquals(getRegistrableDomain("co.uk"), null);
		assertEquals(getRegistrableDomain("gov.sk"), null);
		assertEquals(getRegistrableDomain("com.au"), null);
	});
	await t.step("every second-level label is recognised", () => {
		for (const label of SECOND_LEVEL_LABELS) {
			assertEquals(
				getRegistrableDomain(`x.example.${label}.uk`),
				`example.${label}.uk`,
			);
		}
	});
	await t.step("the ccTLD test really is length-based", () => {
		// "co" in front of a 3-char TLD is just an ordinary label
		assertEquals(getRegistrableDomain("example.co.com"), "co.com");
	});
});

Deno.test("getRegistrableDomain: hosts without a domain structure", async (t) => {
	await t.step("IP literals are returned unchanged", () => {
		assertEquals(getRegistrableDomain("127.0.0.1"), "127.0.0.1");
		assertEquals(getRegistrableDomain("[::1]"), "[::1]");
		assertEquals(getRegistrableDomain("[2001:db8::1]"), "[2001:db8::1]");
	});
	await t.step("single-label hosts are returned unchanged", () => {
		assertEquals(getRegistrableDomain("localhost"), "localhost");
		assertEquals(getRegistrableDomain("intranet"), "intranet");
	});
	await t.step("normalizes case and a trailing root dot", () => {
		assertEquals(getRegistrableDomain("Blog.Example.COM"), "example.com");
		assertEquals(getRegistrableDomain("blog.example.com."), "example.com");
	});
	await t.step("degrades to null, never throws", () => {
		assertEquals(getRegistrableDomain(""), null);
		assertEquals(getRegistrableDomain("   "), null);
		assertEquals(getRegistrableDomain("."), null);
		assertEquals(getRegistrableDomain("a..com"), null);
		assertEquals(getRegistrableDomain(null as unknown as string), null);
	});
});

Deno.test("getRegistrableDomain: documented PSL caveat", () => {
	// Known and accepted: github.io is a real public suffix the heuristic cannot see.
	assertEquals(getRegistrableDomain("alice.github.io"), "github.io");
	assert(isSameSite("https://alice.github.io", "https://bob.github.io", {
		subdomains: "same-site",
	}));
	// ...and this is exactly what the injection point is for.
	const psl = (host: string) => {
		const labels = host.split(".");
		return host.endsWith(".github.io") ? labels.slice(-3).join(".") : null;
	};
	assertFalse(
		isSameSite("https://alice.github.io", "https://bob.github.io", {
			subdomains: "same-site",
			getRegistrableDomain: psl,
		}),
	);
});

Deno.test("isSameSite: same-host is the default", async (t) => {
	await t.step("exact host equality", () => {
		assert(isSameSite("https://a.com/x", "https://a.com/y"));
		assert(
			isSameSite("https://a.com/x", "https://a.com/y", { subdomains: "same-host" }),
		);
		assertFalse(isSameSite("https://a.com/x", "https://blog.a.com/y"));
		assertFalse(isSameSite("https://a.com/x", "https://other.com/y"));
	});
	await t.step("scheme and port are ignored", () => {
		assert(isSameSite("http://a.com/x", "https://a.com:8443/y"));
	});
	await t.step("host comparison is case- and IDN-insensitive via the parser", () => {
		assert(isSameSite("https://A.COM/x", "https://a.com/y"));
		assert(isSameSite("https://münchen.de/", "https://xn--mnchen-3ya.de/"));
	});
	await t.step("www. is a different host", () => {
		assertFalse(isSameSite("https://a.com/", "https://www.a.com/"));
	});
});

Deno.test("isSameSite: same-site mode", async (t) => {
	const opts = { subdomains: "same-site" } as const;
	await t.step("subdomains match", () => {
		assert(isSameSite("https://a.com/", "https://blog.a.com/", opts));
		assert(isSameSite("https://deep.blog.a.com/", "https://a.com/", opts));
		assert(
			isSameSite("https://www.example.co.uk/", "https://shop.example.co.uk/", opts),
		);
	});
	await t.step("different registrable domains do not", () => {
		assertFalse(isSameSite("https://a.com/", "https://b.com/", opts));
		assertFalse(
			isSameSite("https://example.co.uk/", "https://example.org.uk/", opts),
		);
	});
	await t.step("a host with no registrable domain still matches itself", () => {
		// widening the mode must never narrow the scope
		assert(isSameSite("https://co.uk/", "https://co.uk/", opts));
		assertFalse(isSameSite("https://co.uk/", "https://gov.sk/", opts));
		assert(isSameSite("http://localhost:3000/a", "http://localhost/b", {
			...opts,
			getRegistrableDomain: () => null, // a strict PSL knows nothing about localhost
		}));
	});
	await t.step("IP literals fall back to host equality", () => {
		assert(isSameSite("https://127.0.0.1:8080/", "https://127.0.0.1/", opts));
		assertFalse(isSameSite("https://127.0.0.1/", "https://127.0.0.2/", opts));
	});
	await t.step("a custom resolver is used instead of the heuristic", () => {
		const always = () => "fixed";
		assert(isSameSite("https://a.com/", "https://b.org/", {
			...opts,
			getRegistrableDomain: always,
		}));
	});
});

Deno.test("isSameSite: any mode", () => {
	assert(isSameSite("https://a.com/", "https://b.com/", { subdomains: "any" }));
	// still requires both sides to be real hosts
	assertFalse(isSameSite("https://a.com/", "mailto:x@b.com", { subdomains: "any" }));
});

Deno.test("isSameSite: unusable input is never the same site", async (t) => {
	await t.step("relative and malformed references", () => {
		for (const mode of ["same-host", "same-site", "any"] as const) {
			const opts = { subdomains: mode };
			assertFalse(isSameSite("/relative", "https://a.com/", opts));
			assertFalse(isSameSite("https://a.com/", "/relative", opts));
			assertFalse(isSameSite("", "", opts));
			assertFalse(isSameSite("not a url", "not a url", opts));
		}
	});
	await t.step("hostless schemes", () => {
		assertFalse(isSameSite("https://a.com/", "mailto:x@a.com"));
		assertFalse(isSameSite("https://a.com/", "javascript:void(0)"));
		assertFalse(isSameSite("https://a.com/", "data:text/plain,hi"));
	});
	await t.step("accepts URL instances as well as strings", () => {
		assert(isSameSite(new URL("https://a.com/x"), new URL("https://a.com/y")));
		assert(isSameSite(new URL("https://a.com/x"), "https://a.com/y"));
	});
});

Deno.test("isSameSite: the DNS root label is not part of the host", async (t) => {
	await t.step("matches what normalizeUrl writes into the frontier", () => {
		assert(isSameSite("https://a.com./x", "https://a.com/y"));
		assert(isSameSite("https://a.com../x", "https://a.com/y"));
		assertEquals(classifyLink("https://a.com./x", "https://a.com/y"), "internal");
	});
	await t.step("and under same-site too", () => {
		assert(isSameSite("https://blog.a.com./x", "https://a.com/y", {
			subdomains: "same-site",
		}));
	});
});

Deno.test("isSameSite: an injected resolver cannot break the contract", async (t) => {
	const opts = { subdomains: "same-site" } as const;
	await t.step("a throwing resolver degrades to host equality", () => {
		const boom = () => {
			throw new Error("psl unavailable");
		};
		assertFalse(isSameSite("https://a.com/", "https://b.com/", {
			...opts,
			getRegistrableDomain: boom,
		}));
		assert(isSameSite("https://a.com/", "https://a.com/", {
			...opts,
			getRegistrableDomain: boom,
		}));
	});
	await t.step("a resolver returning junk never makes hosts equal", () => {
		for (
			const junk of [
				() => undefined as unknown as string,
				() => "",
				() => ({}) as unknown as string,
				() => 42 as unknown as string,
			]
		) {
			assertFalse(
				isSameSite("https://a.com/", "https://b.com/", {
					...opts,
					getRegistrableDomain: junk,
				}),
				`junk resolver made two hosts same-site`,
			);
		}
	});
});

Deno.test("hostsAreSameSite: the primitive isSameSite is built on", async (t) => {
	await t.step("it agrees with isSameSite on every mode", () => {
		const pairs: [string, string][] = [
			["a.com", "a.com"],
			["a.com", "blog.a.com"],
			["a.com", "b.com"],
			["a.co.uk", "blog.a.co.uk"],
			["co.uk", "a.co.uk"],
			["localhost", "localhost"],
			["localhost", "other"],
			["127.0.0.1", "127.0.0.1"],
			["[::1]", "[::1]"],
			["a.com", "a.com."],
			["A.com", "a.com"],
		];
		for (const mode of ["same-host", "same-site", "any"] as const) {
			for (const [a, b] of pairs) {
				assertEquals(
					hostsAreSameSite(a, b, { subdomains: mode }),
					isSameSite(`https://${a}/x`, `https://${b}/y`, {
						subdomains: mode,
					}),
					`${mode}: ${a} vs ${b}`,
				);
			}
		}
	});

	await t.step("an empty host is never the same site as anything", () => {
		assertFalse(hostsAreSameSite("", ""));
		assertFalse(hostsAreSameSite("", "a.com"));
		assertFalse(hostsAreSameSite("a.com", ""));
		assertFalse(hostsAreSameSite("", "", { subdomains: "any" }));
		// deno-lint-ignore no-explicit-any
		assertFalse(hostsAreSameSite(null as any, "a.com"));
	});

	await t.step(
		"inputs are normalized, so a config-file host compares correctly",
		() => {
			assert(hostsAreSameSite("A.COM.", "a.com"));
			assert(hostsAreSameSite("a.com..", "a.com"));
		},
	);

	await t.step("it is reflexive and symmetric under every mode", () => {
		const hosts = ["a.com", "blog.a.com", "co.uk", "localhost", "127.0.0.1"];
		for (const mode of ["same-host", "same-site", "any"] as const) {
			for (const a of hosts) {
				assert(hostsAreSameSite(a, a, { subdomains: mode }), `${mode} ${a}`);
				for (const b of hosts) {
					assertEquals(
						hostsAreSameSite(a, b, { subdomains: mode }),
						hostsAreSameSite(b, a, { subdomains: mode }),
						`${mode}: ${a} vs ${b}`,
					);
				}
			}
		}
	});

	await t.step("an injected resolver is honored, and honored defensively", () => {
		const opts = {
			subdomains: "same-site" as const,
			getRegistrableDomain: (host: string) =>
				host.endsWith(".github.io") ? host : null,
		};
		assertFalse(hostsAreSameSite("alice.github.io", "bob.github.io", opts));
		assert(hostsAreSameSite("alice.github.io", "alice.github.io", opts));
		// null for both falls back to host equality, never to "equal"
		assertFalse(hostsAreSameSite("a.com", "b.com", opts));
	});
});
