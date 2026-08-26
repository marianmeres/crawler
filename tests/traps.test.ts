/**
 * Trap detection: the pure URL-shape caps, the two per-run counters, and the three
 * enforcement paths through the engine.
 *
 * Every cap is asserted **at its boundary** — at the cap allowed, one over rejected.
 * That is the whole point of the unit half: a guard whose limit is never actually
 * reached in a test can be deleted without a single failure, and a crawler's trap caps
 * are exactly the kind of code nobody notices has stopped working until a crawl runs
 * for three days.
 *
 * The engine half crawls two calendars — one that explodes its query string, one that
 * nests its path — because those are the two shapes real sites produce and they take
 * different routes through the code (`checkAndCount` vs `detectUrlTrap`). Both would run
 * forever without the caps, so both carry a `maxPages` backstop *and* assert
 * `stoppedBy === "completed"`: a broken cap fails the assertion instead of hanging the
 * suite.
 *
 * @module
 */

import { assert, assertEquals, assertFalse } from "@std/assert";
import type { FetchFn } from "@marianmeres/page-fetcher";
import { crawl } from "../src/crawler.ts";
import { resolveCrawlOptions } from "../src/options.ts";
import { createTrapTracker, detectUrlTrap } from "../src/engine/traps.ts";
import type { TrapOptions } from "../src/types.ts";
import {
	makeResult,
	type MiniSite,
	recordingLogger,
	SITE,
	siteFetch,
} from "./_helpers.ts";

const trapsOf = (traps: TrapOptions = {}) => resolveCrawlOptions({ traps }).traps;

const isTrap = (url: string, traps: TrapOptions = {}) =>
	detectUrlTrap(new URL(url), trapsOf(traps));

/** `/a/b/a/b/…` — `repeats` occurrences of each of the two segments. */
const repeated = (repeats: number) => `${SITE}/${"a/b/".repeat(repeats)}`;

/** A path of exactly `depth` segments. */
const deep = (depth: number) =>
	`${SITE}/${Array.from({ length: depth }, (_, i) => `s${i}`).join("/")}`;

/** A query string of exactly `count` distinct parameters. */
const params = (count: number) =>
	`${SITE}/search?${Array.from({ length: count }, (_, i) => `p${i}=1`).join("&")}`;

// ------------------------------------------------------------------------------------
// detectUrlTrap — pure
// ------------------------------------------------------------------------------------

Deno.test("detectUrlTrap: maxSegmentRepeat", async (t) => {
	await t.step("at the default cap is allowed, one over is not", () => {
		assertFalse(isTrap(repeated(3)));
		assert(isTrap(repeated(4)));
	});

	await t.step("counts each segment separately", () => {
		// "a" appears 4 times, "b" only twice — one segment over the cap is enough
		assertFalse(isTrap(`${SITE}/a/b/a/b/a/a`, { maxSegmentRepeat: 4 }));
		assert(isTrap(`${SITE}/a/b/a/b/a/a`, { maxSegmentRepeat: 3 }));
	});

	await t.step("a long path of distinct segments is not a repeat trap", () => {
		assertFalse(isTrap(deep(19)));
	});

	await t.step("Infinity disables it", () => {
		assertFalse(
			isTrap(repeated(50), { maxSegmentRepeat: Infinity, maxPathDepth: 500 }),
		);
	});
});

Deno.test("detectUrlTrap: maxPathDepth", async (t) => {
	await t.step("at the default cap is allowed, one over is not", () => {
		assertFalse(isTrap(deep(20)));
		assert(isTrap(deep(21)));
	});

	await t.step("empty segments do not count — a trailing slash is not depth", () => {
		assertFalse(isTrap(`${SITE}/a/b/`, { maxPathDepth: 2 }));
		assertFalse(isTrap(`${SITE}/`, { maxPathDepth: 1 }));
	});

	await t.step("it is URL depth, not crawl depth: one link can exceed it", () => {
		assert(isTrap(deep(6), { maxPathDepth: 5 }));
	});

	await t.step("Infinity disables it", () => {
		assertFalse(
			isTrap(deep(500), { maxPathDepth: Infinity, maxSegmentRepeat: Infinity }),
		);
	});
});

Deno.test("detectUrlTrap: maxQueryParams", async (t) => {
	await t.step("at the default cap is allowed, one over is not", () => {
		assertFalse(isTrap(params(32)));
		assert(isTrap(params(33)));
	});

	await t.step("distinct names — a repeated multi-select is one parameter", () => {
		assertFalse(isTrap(`${SITE}/s?tag=a&tag=b&tag=c&tag=d`, { maxQueryParams: 1 }));
		assert(isTrap(`${SITE}/s?tag=a&sort=b`, { maxQueryParams: 1 }));
	});

	await t.step("no query string at all is never a trap", () => {
		assertFalse(isTrap(`${SITE}/s`, { maxQueryParams: 1 }));
	});

	await t.step("Infinity disables it", () => {
		assertFalse(isTrap(params(500), { maxQueryParams: Infinity }));
	});
});

// ------------------------------------------------------------------------------------
// createTrapTracker — the per-run counters
// ------------------------------------------------------------------------------------

Deno.test("trapTracker.checkAndCount: per (host, pathname) explosion", async (t) => {
	await t.step("the cap counts distinct URLs; the one over it is the trap", () => {
		const tracker = createTrapTracker(trapsOf({ maxUrlsPerPath: 3 }));
		for (let i = 0; i < 3; i++) {
			assertFalse(tracker.checkAndCount(new URL(`${SITE}/s?q=${i}`)), `#${i}`);
		}
		assert(tracker.checkAndCount(new URL(`${SITE}/s?q=3`)));
	});

	await t.step("a URL seen twice consumes one slot, not two", () => {
		const tracker = createTrapTracker(trapsOf({ maxUrlsPerPath: 2 }));
		assertFalse(tracker.checkAndCount(new URL(`${SITE}/s?q=1`)));
		assertFalse(tracker.checkAndCount(new URL(`${SITE}/s?q=1`)));
		assertFalse(tracker.checkAndCount(new URL(`${SITE}/s?q=2`)));
		assert(tracker.checkAndCount(new URL(`${SITE}/s?q=3`)));
		// ...and a URL already admitted stays admitted afterwards
		assertFalse(tracker.checkAndCount(new URL(`${SITE}/s?q=1`)));
	});

	await t.step("the key is host + pathname: neighbours have their own budget", () => {
		const tracker = createTrapTracker(trapsOf({ maxUrlsPerPath: 1 }));
		assertFalse(tracker.checkAndCount(new URL(`${SITE}/a?q=1`)));
		assert(tracker.checkAndCount(new URL(`${SITE}/a?q=2`)));
		assertFalse(tracker.checkAndCount(new URL(`${SITE}/b?q=2`)));
		assertFalse(tracker.checkAndCount(new URL("http://other.test/a?q=2")));
	});

	await t.step("Infinity disables it", () => {
		const tracker = createTrapTracker(trapsOf({ maxUrlsPerPath: Infinity }));
		for (let i = 0; i < 1000; i++) {
			assertFalse(tracker.checkAndCount(new URL(`${SITE}/s?q=${i}`)));
		}
	});
});

Deno.test("trapTracker.countHash: soft-404 duplicates", async (t) => {
	await t.step(
		"the threshold is a number of pages, and the next one is over it",
		() => {
			const tracker = createTrapTracker(trapsOf({ softDupThreshold: 3 }));
			for (let i = 0; i < 3; i++) assertFalse(tracker.countHash("h1"), `#${i}`);
			assert(tracker.countHash("h1"));
			assert(tracker.countHash("h1"), "and it stays over");
			assertEquals(tracker.softDupHashes(), ["h1"]);
		},
	);

	await t.step("hashes are counted independently", () => {
		const tracker = createTrapTracker(trapsOf({ softDupThreshold: 2 }));
		assertFalse(tracker.countHash("h1"));
		assertFalse(tracker.countHash("h2"));
		assertFalse(tracker.countHash("h1"));
		assertFalse(tracker.countHash("h2"));
		assertEquals(tracker.softDupHashes(), []);
		assert(tracker.countHash("h2"));
		assertEquals(tracker.softDupHashes(), ["h2"]);
	});

	await t.step("warns once per hash, naming the hash and a sample URL", () => {
		const logger = recordingLogger();
		const tracker = createTrapTracker(trapsOf({ softDupThreshold: 1 }), logger);
		tracker.countHash("h1", `${SITE}/a`);
		tracker.countHash("h1", `${SITE}/b`);
		tracker.countHash("h1", `${SITE}/c`);

		const warnings = logger.messages("warn");
		assertEquals(warnings.length, 1);
		assert(warnings[0].includes("h1"));
		assert(warnings[0].includes(`${SITE}/b`));
	});

	await t.step("Infinity disables it — and nothing is ever flagged", () => {
		const tracker = createTrapTracker(trapsOf({ softDupThreshold: Infinity }));
		for (let i = 0; i < 1000; i++) assertFalse(tracker.countHash("h1"));
		assertEquals(tracker.softDupHashes(), []);
	});
});

// ------------------------------------------------------------------------------------
// the engine
// ------------------------------------------------------------------------------------

/**
 * An endless calendar: every URL it is asked for answers with a link to the next day.
 *
 * Generative rather than a {@linkcode MiniSite} on purpose — the fixture has to be
 * genuinely infinite, or the test would prove that a finite site ends.
 *
 * @param nextHref How the "next day" is spelled. An absolute `?date=` query is the
 * faceted signature `maxUrlsPerPath` exists for; a relative path is the nesting one
 * `maxSegmentRepeat`/`maxPathDepth` catch.
 */
function calendarFetch(nextHref: (url: URL) => string): FetchFn & { calls: string[] } {
	const calls: string[] = [];
	const fetch: FetchFn = (req) => {
		calls.push(req.url);
		const url = new URL(req.url);
		return Promise.resolve(makeResult({
			url: req.url,
			body: `<title>${url.pathname}${url.search}</title>` +
				`<a href="${nextHref(url)}">next day</a>`,
			contentType: "text/html",
			headers: { "content-type": "text/html; charset=utf-8" },
		}));
	};
	return Object.assign(fetch, { calls });
}

const nextDay = (date: string) =>
	new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

Deno.test("traps — a query-param calendar terminates on maxUrlsPerPath", async () => {
	const fake = calendarFetch((url) =>
		`/calendar?date=${nextDay(url.searchParams.get("date")!)}`
	);
	const report = await crawl(`${SITE}/calendar?date=2026-01-02`, {
		fetcher: fake,
		robots: { respect: false },
		traps: { maxUrlsPerPath: 5 },
		// a backstop, not the subject: without the cap this crawl never ends, and the
		// `completed` assertion below is what distinguishes the two
		maxPages: 100,
	});

	assertEquals(report.stoppedBy, "completed");
	// the seed plus the five distinct URLs the path was allowed to produce
	assertEquals(report.pages.length, 6);
	assertEquals(report.stats.skippedByReason.trap, 1);

	const skipped = report.graph.filter((edge) => edge.skipReason === "trap");
	assertEquals(skipped.length, 1);
	assertEquals(skipped[0].to, `${SITE}/calendar?date=2026-01-08`);
	assertFalse(fake.calls.includes(`${SITE}/calendar?date=2026-01-08`));
});

Deno.test("traps — a path-nesting calendar terminates on the default caps", async () => {
	// the classic relative-link loop: `<a href="2026/02">` under `/calendar/2026/01`
	// resolves to `/calendar/2026/2026/02`, and so on forever
	const fake = calendarFetch(() => "2026/02");
	const report = await crawl(`${SITE}/calendar/2026/01`, {
		fetcher: fake,
		robots: { respect: false },
		maxPages: 100,
	});

	assertEquals(report.stoppedBy, "completed");
	// "2026" may repeat three times; the URL that would make it four is the trap
	assertEquals(report.pages.map((page) => page.url), [
		`${SITE}/calendar/2026/01`,
		`${SITE}/calendar/2026/2026/02`,
		`${SITE}/calendar/2026/2026/2026/02`,
	]);
	assertEquals(report.stats.skippedByReason.trap, 1);
	assertEquals(
		report.graph.find((edge) => edge.skipReason === "trap")?.to,
		`${SITE}/calendar/2026/2026/2026/2026/02`,
	);
});

Deno.test("traps — a soft-404 farm stops being expanded once its body repeats", async () => {
	// every `/sN/index` answers with the same bytes; only the relative link makes their
	// outlinks distinct, which is exactly how a soft-404 farm grows a crawl
	const softBody = `<title>Not found</title><a href="child">child</a>`;
	const site: MiniSite = {
		[`${SITE}/`]: {
			html: `<title>Hub</title>` +
				[1, 2, 3, 4, 5].map((i) => `<a href="/s${i}/index">s${i}</a>`).join(""),
		},
	};
	for (const i of [1, 2, 3, 4, 5]) {
		site[`${SITE}/s${i}/index`] = { html: softBody };
		site[`${SITE}/s${i}/child`] = { html: `<title>child ${i}</title>` };
	}

	const fake = siteFetch(site);
	const logger = recordingLogger();
	const report = await crawl(`${SITE}/`, {
		fetcher: fake,
		robots: { respect: false },
		logger,
		// FIFO within a depth, so the fourth `/sN/` is deterministically the one that
		// crosses the threshold
		concurrency: 1,
		perHostConcurrency: 1,
		traps: { softDupThreshold: 3 },
	});

	// the duplicate pages are still fetched and still delivered — they are simply no
	// longer a source of new work
	assertEquals(report.stoppedBy, "completed");
	for (const i of [1, 2, 3, 4, 5]) {
		assert(report.pages.some((page) => page.url === `${SITE}/s${i}/index`), `s${i}`);
	}

	assertEquals(
		report.pages.filter((page) => page.url.endsWith("/child")).map((p) => p.url),
		[`${SITE}/s1/child`, `${SITE}/s2/child`, `${SITE}/s3/child`],
	);
	assertEquals(report.stats.skippedByReason.trap, 2);
	assertFalse(fake.calls.some((req) => req.url === `${SITE}/s4/child`));

	const warnings = logger.messages("warn").filter((m) => m.includes("share one body"));
	assertEquals(warnings.length, 1);
	assert(warnings[0].includes(report.pages[1].contentHash!));
});
