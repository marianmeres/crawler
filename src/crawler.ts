/**
 * The two entry points: {@linkcode createCrawler} (streaming, the primary API) and
 * {@linkcode crawl} (collect-everything convenience).
 *
 * Both are thin: options are resolved and validated at construction, and everything
 * after that is `src/engine/dispatcher.ts` — the dispatcher loop, the worker pool,
 * per-host politeness and the bounded channel behind `run()`.
 *
 * @module
 */

import { CrawlEngine } from "./engine/dispatcher.ts";
import type {
	Crawler,
	CrawlOptions,
	CrawlReport,
	CrawlStats,
	PageResult,
} from "./types.ts";

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
	const engine = new CrawlEngine(options);

	return {
		crawlId: engine.crawlId,
		add: (urls, init) => engine.add(urls, init),
		run: (seeds?: string | string[]): AsyncIterableIterator<PageResult> =>
			engine.run(seeds),
		stop: (reason?: string): Promise<void> => engine.stop(reason),
		abort: (reason?: string): void => engine.abort(reason),
		stats: (): CrawlStats => engine.stats(),
		report: (): CrawlReport | undefined => engine.report(),
		[Symbol.asyncDispose]: (): Promise<void> => engine.dispose(),
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
