/**
 * `maskUserinfo` — the one thing that keeps a URL's password out of the logs.
 *
 * A URL carrying userinfo stays verbatim in the data (that is the owner's decision, and
 * the second half of this file pins it: `report.pages[0].url` keeps its credentials).
 * The mitigation for that decision is that no *message* may repeat the password, so the
 * crawl below is driven through every warn path `src/**` has that interpolates a URL —
 * a rejected `add()`, a robots-disallowed seed, an unreadable sitemap, the region
 * fallback and a throwing `priority` — and then asserts the password appears in none of
 * them.
 *
 * The adapter-level "unsupported content type" warning is deliberately absent: it is
 * page-fetcher's, and a crawl configured with a bare `FetchFn` never builds an adapter.
 *
 * @module
 */

import { assert, assertEquals, assertFalse } from "@std/assert";
import { createCrawler } from "../src/crawler.ts";
import { maskUserinfo } from "../src/url/_mask-userinfo.ts";
import type { PageResult } from "../src/types.ts";
import { type MiniSite, recordingLogger, siteFetch } from "./_helpers.ts";

// -----------------------------------------------------------------------------------
// the helper
// -----------------------------------------------------------------------------------

Deno.test("maskUserinfo — a password is replaced, everything else survives", () => {
	assertEquals(
		maskUserinfo("https://user:s3cret@host.test/a/b?q=1#f"),
		"https://user:***@host.test/a/b?q=1#f",
	);
	assertEquals(
		maskUserinfo("http://user:s3cret@host.test:8080/"),
		"http://user:***@host.test:8080/",
	);
});

Deno.test("maskUserinfo — no userinfo, no change", () => {
	for (
		const url of [
			"https://host.test/a",
			"https://host.test/a@b",
			"https://host.test/?to=a@b.test",
			"",
		]
	) {
		assertEquals(maskUserinfo(url), url);
	}
});

Deno.test("maskUserinfo — a username alone is not a secret and is left alone", () => {
	assertEquals(maskUserinfo("https://user@host.test/a"), "https://user@host.test/a");
	// a password without a username still is one
	assertEquals(maskUserinfo("https://:s3cret@host.test/"), "https://:***@host.test/");
});

Deno.test("maskUserinfo — the separator is the last `@` of the authority", () => {
	// percent-encoded `@`s are not separators
	assertEquals(
		maskUserinfo("https://us%40er:p%40ss@host.test/x"),
		"https://us%40er:***@host.test/x",
	);
	// a literal one inside the password is not either — the parser encodes it away
	assertEquals(
		maskUserinfo("https://user:pa@ss@host.test/"),
		"https://user:***@host.test/",
	);
	// nor is one in the path
	assertEquals(
		maskUserinfo("https://user:s3cret@host.test/mail/a@b"),
		"https://user:***@host.test/mail/a@b",
	);
});

Deno.test("maskUserinfo — a non-URL string is returned as it came in", () => {
	for (const input of ["not a url", "user:s3cret@host.test", "://@", "@@@"]) {
		assertEquals(maskUserinfo(input), input);
	}
});

Deno.test("maskUserinfo — a backslash authority is rebuilt rather than leaked", () => {
	// `http:\\` is `http://` to the WHATWG parser, so the userinfo cannot be spliced by
	// offset; the components are re-joined instead of the password being passed through
	assertFalse(maskUserinfo("http:\\\\user:s3cret@host.test\\a").includes("s3cret"));
});

// -----------------------------------------------------------------------------------
// the crawl
// -----------------------------------------------------------------------------------

const PASSWORD = "s3cret";
const ORIGIN = "http://cred.test";
const CRED = `http://user:${PASSWORD}@cred.test`;

/**
 * A mini-site whose every page is addressed *with* credentials — the transport keys on
 * the exact URL, so it only answers if the engine kept them.
 */
const CRED_SITE: MiniSite = {
	[`${CRED}/`]: {
		html: `<title>Home</title>
			<a href="/a">A</a>
			<a href="/private/secret">Secret</a>`,
	},
	[`${CRED}/a`]: { html: `<title>A</title>` },
	// robots.txt is fetched per *origin*, which never carries userinfo
	[`${ORIGIN}/robots.txt`]: {
		contentType: "text/plain",
		html: `User-agent: *
Disallow: /private/

Sitemap: ${CRED}/missing-sitemap.xml
`,
	},
};

Deno.test("credentials survive in the data and appear in no message", async () => {
	const logger = recordingLogger();
	const fake = siteFetch(CRED_SITE);
	const crawler = createCrawler({
		fetcher: fake,
		logger,
		collect: { pages: true, graph: true },
		robots: { sitemaps: true },
		// no page here has landmark markup, so this drives the region-fallback warning
		scope: { followRegions: ["main"] },
		strategy: "priority",
		priority: () => {
			throw new Error("priority is not this test's subject");
		},
	});

	// a URL no scheme allows: rejected, and its raw spelling is what gets logged
	crawler.add(`ftp://user:${PASSWORD}@cred.test/x`);

	const pages: PageResult[] = [];
	for await (const page of crawler.run([`${CRED}/`, `${CRED}/private/secret`])) {
		pages.push(page);
	}
	const report = crawler.report()!;

	// the data keeps the credentials — this is what makes the masking necessary
	assertEquals(report.pages[0].url, `${CRED}/`);
	assert(fake.calls.some((call) => call.url === `${CRED}/a`));

	const messages = logger.messages();
	// the warn paths this crawl is built to drive, each one URL-bearing
	assert(messages.some((m) => m.includes("add(): not a usable URL")));
	assert(messages.some((m) => m.includes("seed rejected (robots-disallow)")));
	assert(
		messages.some((m) => m.includes("could not be read") || m.includes("answered")),
	);
	assert(messages.some((m) => m.includes("followRegions")));
	assert(messages.some((m) => m.includes("options.priority")));
	// and the masking itself
	assert(messages.some((m) => m.includes("user:***@cred.test")));
	assertFalse(messages.some((m) => m.includes(PASSWORD)));
});
