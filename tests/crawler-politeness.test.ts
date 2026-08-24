/**
 * Politeness: the two concurrency caps applied *simultaneously*, and per-host spacing.
 *
 * These assert invariants — "never exceeded", "spaced at least this far apart" — rather
 * than exact durations. A test that pins wall-clock timings pins the machine it ran on.
 */

import { assert, assertEquals } from "@std/assert";
import { crawl } from "../src/crawler.ts";
import { siteFetch } from "./_helpers.ts";
import type { MiniSite } from "./_helpers.ts";
import type { FetchFn } from "@marianmeres/page-fetcher";

/** `n` linked pages on one host, each taking `delayMs` to answer. */
function hostSite(host: string, pages: number, delayMs: number): MiniSite {
	const site: MiniSite = {};
	const links = Array.from({ length: pages }, (_, i) => `<a href="/p${i}">p${i}</a>`)
		.join("");
	site[`http://${host}/`] = { html: `<title>${host}</title>${links}`, delayMs };
	for (let i = 0; i < pages; i++) {
		site[`http://${host}/p${i}`] = { html: `<title>p${i}</title>`, delayMs };
	}
	return site;
}

interface Instrumented {
	fetch: FetchFn;
	/** Highest simultaneous in-flight count, globally. */
	maxInFlight: () => number;
	/** Highest simultaneous in-flight count, per host. */
	maxPerHost: () => Map<string, number>;
	/** Dispatch timestamps per host, in order. */
	startsOf: (host: string) => number[];
}

/** Wrap a `FetchFn` in the counters the invariants are read off. */
function instrument(inner: FetchFn): Instrumented {
	let inFlight = 0;
	let maxInFlight = 0;
	const live = new Map<string, number>();
	const peak = new Map<string, number>();
	const starts = new Map<string, number[]>();

	const fetch: FetchFn = async (req) => {
		const host = new URL(req.url).hostname;
		// robots.txt does not go through the frontier, so it is not crawl traffic and
		// is not under the politeness caps — counting it would measure the wrong thing
		if (req.url.endsWith("/robots.txt")) return await inner(req);

		inFlight++;
		maxInFlight = Math.max(maxInFlight, inFlight);
		const now = (live.get(host) ?? 0) + 1;
		live.set(host, now);
		peak.set(host, Math.max(peak.get(host) ?? 0, now));
		starts.set(host, [...(starts.get(host) ?? []), Date.now()]);

		try {
			return await inner(req);
		} finally {
			inFlight--;
			live.set(host, (live.get(host) ?? 1) - 1);
		}
	};

	return {
		fetch,
		maxInFlight: () => maxInFlight,
		maxPerHost: () => peak,
		startsOf: (host) => starts.get(host) ?? [],
	};
}

const THREE_HOSTS: MiniSite = {
	...hostSite("h1.test", 5, 4),
	...hostSite("h2.test", 5, 4),
	...hostSite("h3.test", 5, 4),
};

const THREE_SEEDS = ["http://h1.test/", "http://h2.test/", "http://h3.test/"];

Deno.test("politeness — the global cap and the per-host cap hold at the same time", async () => {
	const probe = instrument(siteFetch(THREE_HOSTS));
	const report = await crawl(THREE_SEEDS, {
		fetcher: probe.fetch,
		concurrency: 3,
		perHostConcurrency: 1,
	});

	assertEquals(report.stats.done, 18);
	assert(
		probe.maxInFlight() <= 3,
		`global concurrency exceeded: ${probe.maxInFlight()} > 3`,
	);
	for (const [host, peak] of probe.maxPerHost()) {
		assert(peak <= 1, `per-host concurrency exceeded on ${host}: ${peak} > 1`);
	}
	// and it really did run in parallel across hosts — otherwise the caps prove nothing
	assert(probe.maxInFlight() > 1, "the crawl never went concurrent at all");
});

Deno.test("politeness — a generous global cap still respects the per-host one", async () => {
	const probe = instrument(siteFetch(THREE_HOSTS));
	await crawl(THREE_SEEDS, {
		fetcher: probe.fetch,
		concurrency: 10,
		perHostConcurrency: 2,
	});

	for (const [host, peak] of probe.maxPerHost()) {
		assert(peak <= 2, `per-host concurrency exceeded on ${host}: ${peak} > 2`);
	}
	assert(probe.maxInFlight() >= 2, "the crawl never went concurrent at all");
});

Deno.test("politeness — perHostDelay spaces consecutive dispatches to one host", async () => {
	const delay = 30;
	const probe = instrument(siteFetch(hostSite("slow.test", 4, 1)));
	await crawl("http://slow.test/", {
		fetcher: probe.fetch,
		perHostDelay: delay,
		perHostConcurrency: 1,
		concurrency: 5,
	});

	const starts = probe.startsOf("slow.test");
	assertEquals(starts.length, 5);
	for (let i = 1; i < starts.length; i++) {
		const gap = starts[i] - starts[i - 1];
		// the delay is measured from dispatch, so this is a floor, never a target;
		// a few ms of slack absorbs timer granularity
		assert(gap >= delay - 5, `dispatch ${i} came ${gap}ms after ${i - 1}`);
	}
});

Deno.test("politeness — perHostDelay does not serialize different hosts", async () => {
	const probe = instrument(siteFetch(THREE_HOSTS));
	const startedAt = Date.now();
	await crawl(THREE_SEEDS, {
		fetcher: probe.fetch,
		perHostDelay: 20,
		perHostConcurrency: 1,
		concurrency: 3,
	});
	const elapsed = Date.now() - startedAt;

	// 18 pages one-at-a-time at 20ms would be ~360ms; three hosts in parallel is ~120ms.
	// The bound is loose on purpose — it only has to fail if the hosts were serialized.
	assert(elapsed < 300, `three hosts took ${elapsed}ms — they were serialized`);
	assert(probe.maxInFlight() > 1, "the crawl never went concurrent at all");
});
