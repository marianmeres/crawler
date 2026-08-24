/**
 * The two entry points: {@linkcode createCrawler} (streaming, the primary API) and
 * {@linkcode crawl} (collect-everything convenience).
 *
 * > **Status.** This module currently provides the *contract* only. Option resolution
 * > and validation are real — a bad option throws at `createCrawler()` — but the engine
 * > behind `run()` (dispatcher, worker pool, politeness, scope, robots, traps) is not
 * > written yet, and every operational method throws until it is.
 *
 * @module
 */

import { resolveCrawlOptions } from "./options.ts";
import type { Crawler, CrawlOptions, CrawlReport } from "./types.ts";

/**
 * Uniform, greppable failure for the parts of {@linkcode Crawler} that need the engine.
 * Deliberately loud: half-working crawl semantics would be far worse than a throw.
 */
function notImplemented(member: string): never {
	throw new Error(
		`[crawler] ${member} is not implemented yet — this version ships the public ` +
			`type surface and option resolution only.`,
	);
}

/**
 * Create a configured, single-use crawler.
 *
 * Options are resolved and validated **here**, not at `run()`, so a typo in a limit is
 * a construction-time `TypeError` rather than a surprise five minutes into a crawl.
 *
 * Nothing is fetched until you iterate {@linkcode Crawler.run}, and because that
 * iterator is backpressured, a slow consumer slows the crawl instead of filling memory.
 * `collect.pages`/`collect.graph` both default to `false` here — stream the results, or
 * use {@linkcode crawl} if you genuinely want everything in one array.
 *
 * @throws {TypeError} on an invalid option (see `resolveCrawlOptions`).
 *
 * @example
 * ```ts
 * const crawler = createCrawler({ maxPages: 100, scope: { subdomains: "same-site" } });
 * for await (const page of crawler.run("https://example.com")) {
 *     console.log(page.status, page.url);
 * }
 * console.log(crawler.report()?.stats);
 * ```
 */
export function createCrawler(options: CrawlOptions = {}): Crawler {
	// for the validation; the engine will keep the result once it exists
	resolveCrawlOptions(options);

	const crawlId = crypto.randomUUID();

	return {
		crawlId,
		add: () => notImplemented("Crawler.add()"),
		run: () => notImplemented("Crawler.run()"),
		stop: () => notImplemented("Crawler.stop()"),
		abort: () => notImplemented("Crawler.abort()"),
		stats: () => notImplemented("Crawler.stats()"),
		report: () => notImplemented("Crawler.report()"),
		// not a stub: disposal releases engine-owned fetchers, and a crawler that never
		// ran owns none
		[Symbol.asyncDispose]: () => Promise.resolve(),
	};
}

/**
 * Crawl to completion and return the whole thing — pages, link graph and stats — in one
 * {@linkcode CrawlReport}.
 *
 * This is the small-crawl convenience. It holds every result in memory, so past a few
 * thousand pages use {@linkcode createCrawler} and iterate `run()` instead.
 *
 * Unlike {@linkcode createCrawler}, `collect.pages` and `collect.graph` default to
 * `true` — that is the whole difference between the two. Pass `collect` explicitly to
 * turn one of them back off (e.g. `{ collect: { graph: false } }` on a large crawl).
 *
 * @example
 * ```ts
 * const report = await crawl("https://example.com", { maxPages: 50 });
 * console.log(report.stoppedBy, report.pages.length, report.graph.length);
 * ```
 */
export async function crawl(
	seeds: string | string[],
	options: CrawlOptions = {},
): Promise<CrawlReport> {
	const crawler = createCrawler({
		...options,
		collect: { pages: true, graph: true, ...options.collect },
	});

	// drained for its side effects — the report is what the caller wants
	for await (const _page of crawler.run(seeds)) {
		// deliberately empty
	}

	return crawler.report()!;
}
