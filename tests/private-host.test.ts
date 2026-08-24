import { assert, assertFalse } from "@std/assert";
import { isPrivateHost } from "../src/engine/private-host.ts";

/**
 * The SSRF speed bump behind `allowPrivateHosts: false`.
 *
 * Two things this suite is really pinning: the *boundaries* of each range (an
 * off-by-one here is a hole, and `172.16.0.0/12` is the one everybody gets wrong), and
 * the fact that the check runs on `URL.hostname` — WHATWG has already turned every
 * exotic IPv4 spelling into dotted decimal by then, which is the only reason a
 * string-only check can work at all.
 */

Deno.test("isPrivateHost: loopback and the unspecified addresses", async (t) => {
	await t.step("by name", () => {
		assert(isPrivateHost("localhost"));
		assert(isPrivateHost("LocalHost"));
		assert(isPrivateHost("db.localhost"));
		assert(isPrivateHost("localhost."));
	});

	await t.step("but not a public host that merely contains the word", () => {
		assertFalse(isPrivateHost("localhost.example.com"));
		assertFalse(isPrivateHost("mylocalhost"));
		assertFalse(isPrivateHost("localhostage.com"));
	});

	await t.step("by address", () => {
		assert(isPrivateHost("127.0.0.1"));
		assert(isPrivateHost("127.255.255.254"));
		assert(isPrivateHost("0.0.0.0"));
		assert(isPrivateHost("0.1.2.3"));
		assert(isPrivateHost("::1"));
		assert(isPrivateHost("::"));
	});
});

Deno.test("isPrivateHost: the RFC 1918 and friends boundaries", async (t) => {
	await t.step("10.0.0.0/8", () => {
		assert(isPrivateHost("10.0.0.0"));
		assert(isPrivateHost("10.255.255.255"));
		assertFalse(isPrivateHost("11.0.0.1"));
		assertFalse(isPrivateHost("9.255.255.255"));
	});

	await t.step("172.16.0.0/12 — the one that is easy to get wrong", () => {
		assertFalse(isPrivateHost("172.15.255.255"));
		assert(isPrivateHost("172.16.0.0"));
		assert(isPrivateHost("172.24.1.1"));
		assert(isPrivateHost("172.31.255.255"));
		assertFalse(isPrivateHost("172.32.0.0"));
	});

	await t.step("192.168.0.0/16", () => {
		assert(isPrivateHost("192.168.0.1"));
		assertFalse(isPrivateHost("192.167.0.1"));
		assertFalse(isPrivateHost("192.169.0.1"));
	});

	await t.step("100.64.0.0/10 — carrier-grade NAT", () => {
		assertFalse(isPrivateHost("100.63.255.255"));
		assert(isPrivateHost("100.64.0.0"));
		assert(isPrivateHost("100.127.255.255"));
		assertFalse(isPrivateHost("100.128.0.0"));
	});

	await t.step("169.254.0.0/16 — link-local, i.e. the cloud metadata endpoint", () => {
		assert(isPrivateHost("169.254.169.254"));
		assert(isPrivateHost("169.254.0.1"));
		assertFalse(isPrivateHost("169.253.0.1"));
		assertFalse(isPrivateHost("169.255.0.1"));
	});
});

Deno.test("isPrivateHost: IPv6", async (t) => {
	await t.step("brackets are what URL.hostname gives us", () => {
		assert(isPrivateHost("[::1]"));
		assert(isPrivateHost("[fe80::1]"));
		assertFalse(isPrivateHost("[2606:4700::1111]"));
	});

	await t.step("link-local and unique-local prefixes", () => {
		assert(isPrivateHost("fe80::1"));
		assert(isPrivateHost("FE80::1"));
		assert(isPrivateHost("fc00::1"));
		assert(isPrivateHost("fd12:3456::1"));
		assertFalse(isPrivateHost("fe81::1"));
		assertFalse(isPrivateHost("2001:4860:4860::8888"));
	});

	await t.step("the IPv4-mapped spelling of a private address", () => {
		assert(isPrivateHost("::ffff:127.0.0.1"));
		assert(isPrivateHost("::ffff:10.0.0.1"));
		assert(isPrivateHost("[::ffff:192.168.1.1]"));
		assertFalse(isPrivateHost("::ffff:8.8.8.8"));
	});
});

Deno.test("isPrivateHost: public hosts are public", () => {
	for (
		const host of [
			"example.com",
			"www.example.co.uk",
			"8.8.8.8",
			"1.1.1.1",
			"93.184.216.34",
			"xn--mnchen-3ya.de",
		]
	) {
		assertFalse(isPrivateHost(host), host);
	}
});

Deno.test("isPrivateHost: it is fed URL.hostname, which is already normalized", () => {
	// this is the whole reason a string check can work: `0x7f.1`, `2130706433` and
	// `0177.0.0.1` are all spellings of 127.0.0.1, and WHATWG resolves every one of
	// them before we see it
	for (const spelling of ["0x7f.1", "2130706433", "0177.0.0.1", "127.1"]) {
		const host = new URL(`http://${spelling}/`).hostname;
		assert(isPrivateHost(host), `${spelling} -> ${host}`);
	}
	// and the decimal form of a public address survives the same trip
	assertFalse(isPrivateHost(new URL("http://0x08080808/").hostname));
});

Deno.test("isPrivateHost: junk is not private, and is not an error", () => {
	const junk: unknown[] = [
		"",
		"   ",
		".",
		"..",
		":",
		"999.1.1.1",
		"1.2.3",
		null,
		undefined,
		0,
	];
	for (const value of junk) {
		assertFalse(isPrivateHost(value as string), String(value));
	}
});
