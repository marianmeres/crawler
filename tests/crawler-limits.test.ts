/**
 * The three budgets — `maxPages`, `maxDuration`, `maxTotalBytes` — and the
 * {@linkcode StoppedBy} value each of them latches.
 *
 * All three take the same graceful path: dispatch stops, whatever is already in flight
 * still finishes and is still delivered. That is what every test here checks twice —
 * once for the `stoppedBy`, once for the overshoot the graceful path implies.
 *
 * `maxDepth` gets a test of its own for the opposite reason: it is deliberately **not** a
 * `stoppedBy` value.
 *
 * @module
 */

import {
	assert,
	assertEquals,
	assertFalse,
	assertGreaterOrEqual,
	assertLess,
} from "@std/assert";
import { crawl, createCrawler } from "../src/crawler.ts";
import { type MiniSite, SITE, siteFetch, SMALL_SITE } from "./_helpers.ts";

/**
 * A hub linking to `leaves` pages, each of which links on to a child of its own — so
 * there is always more queued work than any budget here is going to spend.
 *
 * @param delayMs Per-leaf latency, by index. Staggering it is how a test pins *which*
 * page is still in flight when the budget lands.
 */
function fanSite(leaves: number, delayMs: (i: number) => number = () => 0): MiniSite {
	const links = Array.from(
		{ length: leaves },
		(_, i) => `<a href="/p${i}">p${i}</a>`,
	).join("");
	const site: MiniSite = { [`${SITE}/`]: { html: `<title>Hub</title>${links}` } };

	for (let i = 0; i < leaves; i++) {
		const delay = delayMs(i);
		site[`${SITE}/p${i}`] = {
			html: `<title>p${i}</title><a href="/p${i}-c">child</a>`,
			...(delay > 0 ? { delayMs: delay } : {}),
		};
		site[`${SITE}/p${i}-c`] = { html: `<title>p${i} child</title>` };
	}
	return site;
}

// -----------------------------------------------------------------------------------
// maxPages
// -----------------------------------------------------------------------------------

Deno.test("maxPages — latches, drains what is in flight, leaves the rest queued", async () => {
	// p1 is slow, so the cap is reached while it is still being fetched: its outlinks
	// are the ones "discovered after the cap"
	const fake = siteFetch(fanSite(6, (i) => (i === 1 ? 150 : 10)));
	const report = await crawl(`${SITE}/`, {
		fetcher: fake,
		robots: { respect: false },
		concurrency: 3,
		perHostConcurrency: 3,
		maxPages: 2,
	});

	assertEquals(report.stoppedBy, "maxPages");
	// budgets are not a `stop()` reason — nobody passed one
	assertEquals(report.stoppedReason, undefined);

	// the cap counts completions, and the pages already in flight when it was reached
	// still ran: over the cap, but by no more than the pool could hold
	const completed = report.stats.done + report.stats.failed;
	assertGreaterOrEqual(completed, 2);
	assertLess(completed, 2 + 3 + 1);
	assertEquals(report.pages.length, completed);
	// ...delivered, not merely counted
	assert(report.pages.some((page) => page.url === `${SITE}/p1`));

	// links discovered after the cap are skips
	assertGreaterOrEqual(report.stats.skippedByReason["max-pages"] ?? 0, 1);
	assertEquals(
		report.graph.filter((edge) => edge.skipReason === "max-pages").length,
		report.stats.skippedByReason["max-pages"],
	);

	// ...but what was already queued stays queued: still followed, never fetched, and
	// never rewritten into a skip
	assertGreaterOrEqual(report.stats.queued, 1);
	const late = report.graph.find((edge) => edge.to === `${SITE}/p5`)!;
	assert(late.followed, "an already-queued link must not become a skip");
	assertFalse(fake.calls.some((req) => req.url === `${SITE}/p5`));
});

// -----------------------------------------------------------------------------------
// maxDuration
// -----------------------------------------------------------------------------------

Deno.test("maxDuration — stops on the deadline and still delivers the page in flight", async () => {
	const site: MiniSite = {
		[`${SITE}/`]: { html: `<title>Hub</title><a href="/slow">slow</a>` },
		[`${SITE}/slow`]: {
			html: `<title>Slow</title><a href="/after">after</a>`,
			delayMs: 250,
		},
	};
	const fake = siteFetch(site);
	const report = await crawl(`${SITE}/`, {
		fetcher: fake,
		robots: { respect: false },
		maxDuration: 60,
	});

	assertEquals(report.stoppedBy, "maxDuration");
	assertEquals(report.stoppedReason, undefined);
	assertGreaterOrEqual(report.stats.elapsed, 60);

	// the deadline landed mid-fetch; `/slow` is a hard deadline's loss and a budget's
	// delivery, which is the whole difference between the two
	assertEquals(report.pages.map((page) => page.url), [`${SITE}/`, `${SITE}/slow`]);
	// `/after` was discovered after the deadline: still queued (no page budget was
	// reached), never dispatched
	assertEquals(report.stats.queued, 1);
	assertFalse(fake.calls.some((req) => req.url === `${SITE}/after`));
});

// -----------------------------------------------------------------------------------
// maxTotalBytes
// -----------------------------------------------------------------------------------

/** Every body in {@linkcode byteSite} is exactly this many bytes. */
const PAGE_BYTES = 200;

/** Pad `html` with a comment until it is exactly `bytes` long. ASCII only, by design. */
function padTo(html: string, bytes: number): string {
	const fill = bytes - html.length - "<!---->".length;
	if (fill < 0) throw new Error(`cannot pad ${html.length} bytes down to ${bytes}`);
	return `${html}<!--${"x".repeat(fill)}-->`;
}

/** A hub plus `leaves` leaves, every body {@linkcode PAGE_BYTES} — so bytes are arithmetic. */
function byteSite(leaves: number): MiniSite {
	const links = Array.from({ length: leaves }, (_, i) => `<a href="/p${i}">${i}</a>`)
		.join("");
	const site: MiniSite = {
		[`${SITE}/`]: { html: padTo(`<title>Hub</title>${links}`, PAGE_BYTES) },
	};
	for (let i = 0; i < leaves; i++) {
		site[`${SITE}/p${i}`] = { html: padTo(`<title>p${i}</title>`, PAGE_BYTES) };
	}
	return site;
}

Deno.test("maxTotalBytes — stops after the crossing, overshooting by at most `concurrency`", async () => {
	const concurrency = 3;
	// crossed on the third completion: one hub plus two leaves
	const budget = PAGE_BYTES * 3;

	const report = await crawl(`${SITE}/`, {
		fetcher: siteFetch(byteSite(8)),
		robots: { respect: false },
		concurrency,
		perHostConcurrency: concurrency,
		maxTotalBytes: budget,
	});

	assertEquals(report.stoppedBy, "maxTotalBytes");
	assertEquals(report.stoppedReason, undefined);

	// checked *after* each completion, so the budget is crossed rather than respected
	assertGreaterOrEqual(report.stats.bytes, budget);
	// and the responses already in flight are the only thing that can overshoot it
	assertLess(report.stats.bytes, budget + concurrency * PAGE_BYTES);
	assertEquals(report.stats.bytes, report.pages.length * PAGE_BYTES);
	assertLess(report.pages.length, 9);
});

// -----------------------------------------------------------------------------------
// maxDepth is not a budget
// -----------------------------------------------------------------------------------

Deno.test("maxDepth — prunes expansion, and the crawl still ends `completed`", async () => {
	const report = await crawl(`${SITE}/`, {
		fetcher: siteFetch(SMALL_SITE),
		robots: { respect: false },
		maxDepth: 0,
	});

	// depth never stops a run: it only makes it a shorter one
	assertEquals(report.stoppedBy, "completed");
	assertEquals(report.pages.map((page) => page.url), [`${SITE}/`]);
	assertGreaterOrEqual(report.stats.skippedByReason["max-depth"] ?? 0, 1);
});

// -----------------------------------------------------------------------------------
// precedence
// -----------------------------------------------------------------------------------

Deno.test("precedence — a `stop()` that latched first survives a later budget crossing", async () => {
	const crawler = createCrawler({
		fetcher: siteFetch(fanSite(4, () => 200)),
		robots: { respect: false },
		concurrency: 5,
		perHostConcurrency: 5,
		maxPages: 2,
	});

	// the hub completes instantly and the four slow leaves are dispatched at once; the
	// stop lands while they are all still in flight, the page cap only when they land
	const timer = setTimeout(() => void crawler.stop("enough"), 50);
	for await (const _page of crawler.run(`${SITE}/`)) {
		// drained for the report
	}
	clearTimeout(timer);

	const report = crawler.report()!;
	assertEquals(report.stoppedBy, "stop");
	assertEquals(report.stoppedReason, "enough");
	// the budget really was crossed afterwards — otherwise this proves nothing
	assertGreaterOrEqual(report.stats.done + report.stats.failed, 3);
});

Deno.test("precedence — `abort()` overrides a budget that already latched", async () => {
	const crawler = createCrawler({
		fetcher: siteFetch({
			[`${SITE}/`]: { html: `<title>Hub</title><a href="/slow">slow</a>` },
			[`${SITE}/slow`]: { html: `<title>Slow</title>`, delayMs: 250 },
		}),
		robots: { respect: false },
		maxDuration: 40,
	});

	// 40ms: the deadline latches `maxDuration`. 100ms: the abort overtakes it, while
	// `/slow` still has 150ms to go and the report is therefore not frozen yet.
	const timer = setTimeout(() => crawler.abort("cancelled"), 100);
	for await (const _page of crawler.run(`${SITE}/`)) {
		// drained for the report
	}
	clearTimeout(timer);

	assertEquals(crawler.report()?.stoppedBy, "abort");
	assertEquals(crawler.report()?.stoppedReason, "cancelled");
});
