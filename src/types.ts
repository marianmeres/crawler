/**
 * The complete public type surface of `@marianmeres/crawler`.
 *
 * Everything a consumer can pass in ({@linkcode CrawlOptions} and its sub-option
 * objects), everything they get back ({@linkcode PageResult}, {@linkcode LinkRecord},
 * {@linkcode CrawlStats}, {@linkcode CrawlReport}) and the shape of the crawler handle
 * itself ({@linkcode Crawler}) live here. Runtime code lives elsewhere; this module is
 * types only.
 *
 * Two things worth knowing before reading on:
 *
 * 1. **Transport is `@marianmeres/page-fetcher`.** This package never opens a socket
 *    and never retries a page — page-fetcher already did. A failed fetch is a terminal
 *    {@linkcode PageResult} carrying `error`, not a re-queue.
 * 2. **Bodies are not in the results.** {@linkcode PageResult} deliberately holds no
 *    body — a 50k-page crawl would not fit in memory. The body is reachable during the
 *    crawl via {@linkcode PageContext.fetchResult}, which is what `onPage` and the
 *    persistence layer consume.
 *
 * @module
 */

import type { Fetcher, FetchFn, FetchResult, Logger } from "@marianmeres/page-fetcher";
import type { ExtractOptions, LinkRegion } from "./extract/types.ts";
import type {
	FrontierItem,
	FrontierStore,
	VisitedState,
	VisitedStore,
} from "./stores/types.ts";
import type { NormalizeOptions } from "./url/mod.ts";

// Re-exported so consumers can type a fetcher, a logger or a store without importing
// page-fetcher (or this package's `./stores` subpath) themselves — the page-fetcher
// `Logger` re-export precedent.
export type {
	ExtractOptions,
	Fetcher,
	FetchFn,
	FetchResult,
	LinkRegion,
	Logger,
	NormalizeOptions,
};
export type { FrontierItem, FrontierStore, VisitedState, VisitedStore };

// -----------------------------------------------------------------------------------
// options
// -----------------------------------------------------------------------------------

/**
 * How permissive the crawl is about *which* URLs it is willing to follow. Evaluated
 * per extracted link, in a fixed order, and every rejection is recorded as a
 * {@linkcode SkipReason} — this crawler never drops a link silently.
 */
export interface ScopeOptions {
	/**
	 * Host-locality rule, evaluated with `isSameSite` from the `./url` submodule.
	 * Default `"same-host"` — `blog.a.com` is *not* in scope for a crawl seeded at
	 * `a.com`.
	 */
	subdomains?: "same-host" | "same-site" | "any";
	/** Allow-list matched against the absolute URL. A miss reports `"excluded"`. */
	include?: (string | RegExp)[];
	/** Deny-list matched against the absolute URL. Wins over {@linkcode include}. */
	exclude?: (string | RegExp)[];
	/** Restrict to URLs whose pathname starts with one of these. */
	pathPrefix?: string | string[];
	/** Follow links that leave the site. Default `false` — they are recorded, not visited. */
	allowExternal?: boolean;
	/**
	 * Fetch each external URL **once**, without expanding it (no link extraction) and
	 * without retaining its body — the broken-link-checker mode. Default `false`.
	 */
	checkExternal?: boolean;
	/** Follow links marked `rel="nofollow"` anyway. Default `false`. */
	followNofollow?: boolean;
	/**
	 * Follow only links whose {@linkcode LinkRecord.region} is listed — the "crawl the
	 * content, ignore the chrome" mode. Links outside the listed landmarks are still
	 * extracted and still recorded in the graph; they are simply not visited, with
	 * `skipReason: "out-of-region"`. Default `[]`, i.e. no region filtering.
	 *
	 * Prefer `["main", "article"]` over `["main"]`: {@linkcode LinkRegion} is the
	 * *innermost* landmark, so a link inside `<main><article>` reports `"article"` and
	 * `["main"]` alone would skip the entire body of a typical blog or docs page.
	 *
	 * **Fallback** — if a document yields no regioned links at all (no landmark markup
	 * anywhere), region filtering does not apply to that document and every link is
	 * considered. Without this a single non-semantic page would silently dead-end the
	 * crawl. The engine warns once per crawl the first time it fires.
	 */
	followRegions?: LinkRegion[];
	/** Reject longer URLs with `"too-long"`. Default `2048`. */
	maxUrlLength?: number;
}

/**
 * Why a discovered link was not followed. Recorded on the
 * {@linkcode LinkRecord.skipReason}, emitted as `events.onLinkSkipped`, and counted in
 * {@linkcode CrawlStats.skippedByReason}.
 *
 * A skip is **never** turned into a placeholder {@linkcode PageResult} — nothing that
 * was not fetched appears in the result stream.
 */
export type SkipReason =
	| "out-of-scope"
	| "excluded"
	| "duplicate"
	| "max-depth"
	| "max-pages"
	| "nofollow"
	| "robots-disallow"
	| "bad-scheme"
	| "unsupported-type"
	| "trap"
	| "too-long"
	| "private-host"
	| "queue-full"
	| "out-of-region"
	| "user";

/** robots.txt policy. Parsing lives in `./extract`; this is cache + enforcement. */
export interface RobotsOptions {
	/**
	 * Honor robots.txt. Default `true`. Setting it to `false` is legal but logs one
	 * warning at run start — an impolite crawler is a deliberate act, not an accident.
	 */
	respect?: boolean;
	/**
	 * Seed the frontier from the `Sitemap:` lines of each origin's robots.txt.
	 * Default `false`.
	 */
	sitemaps?: boolean;
	/** Cap on an honored `Crawl-delay`, in ms. Default `30_000`. */
	crawlDelayCap?: number;
	/** Byte cap on a robots.txt fetch. Default `512_000`. */
	maxBytes?: number;
	/**
	 * Transport override for robots.txt only — for auth/proxy setups. By default the
	 * engine uses its own small HTTP fetcher (always HTTP, even when the main fetcher
	 * is browser-backed) restricted to `text/plain`.
	 */
	fetch?: FetchFn;
}

/**
 * Caps that keep a crawl out of infinite URL spaces — calendars, faceted search, path
 * loops, soft-404 farms. Disable an individual cap with `Infinity`; `0` is rejected.
 */
export interface TrapOptions {
	/** Max repeats of one path segment (`/a/b/a/b/a/b…`). Default `3`. */
	maxSegmentRepeat?: number;
	/** Max path segments in a single URL, independent of crawl depth. Default `20`. */
	maxPathDepth?: number;
	/** Max distinct query parameters in a single URL. Default `32`. */
	maxQueryParams?: number;
	/** Max distinct URLs sharing one `(host, pathname)`, query ignored. Default `200`. */
	maxUrlsPerPath?: number;
	/**
	 * How many pages may share one `contentHash` before further pages with that hash
	 * stop being expanded — the soft-404 signature. Default `10`.
	 */
	softDupThreshold?: number;
}

/** What {@linkcode Crawler.report} accumulates in memory. */
export interface CollectOptions {
	/** Keep every {@linkcode PageResult}. Default `false` (`true` under {@linkcode crawl}). */
	pages?: boolean;
	/** Keep every {@linkcode LinkRecord}. Default `false` (`true` under {@linkcode crawl}). */
	graph?: boolean;
}

/**
 * Everything that configures a crawl. Every field is optional; the documented default
 * of each is what {@linkcode createCrawler} applies.
 */
export interface CrawlOptions {
	// --- transport ---
	/**
	 * Where bytes come from. A page-fetcher `Fetcher` (or a bare `FetchFn`) is used
	 * as-is and **never disposed by the engine** — you built it, you own it.
	 *
	 * Default: an engine-owned `createFetcher({ userAgent, logger })`, i.e. the plain
	 * HTTP adapter, disposed when the run ends. Browser-rendered crawling is
	 * injection-only: build a page-fetcher browser adapter with your driver and pass
	 * the resulting fetcher here.
	 */
	fetcher?: Fetcher | FetchFn;
	/**
	 * `User-Agent` for the engine-owned fetcher and for robots.txt group matching.
	 * Default `"marianmeres-crawler (+https://github.com/marianmeres/crawler)"`.
	 */
	userAgent?: string;

	// --- scheduling ---
	/** Global in-flight cap. Default `5`. */
	concurrency?: number;
	/** In-flight cap per host, applied *simultaneously* with {@linkcode concurrency}. Default `2`. */
	perHostConcurrency?: number;
	/**
	 * Minimum ms between two dispatches to the same host, measured from dispatch. The
	 * effective delay is `max(perHostDelay, robots Crawl-delay)`. Default `0`.
	 */
	perHostDelay?: number;
	/**
	 * Frontier ordering. `"bfs"` (default) makes `depth` the nearest-seed distance;
	 * `"dfs"` and `"priority"` make it first-discovery distance instead.
	 */
	strategy?: "bfs" | "dfs" | "priority";
	/**
	 * Custom frontier sort key — **lower pops first**. Required when
	 * {@linkcode strategy} is `"priority"`, ignored otherwise.
	 */
	priority?: (item: FrontierItem) => number;
	/**
	 * Frontier bound. A link that would overflow it is skipped with `"queue-full"`.
	 * Default `100_000`.
	 */
	maxQueued?: number;

	// --- budgets ---
	/**
	 * Prune expansion beyond this link distance. Deeper links are skipped with
	 * `"max-depth"`; the crawl still ends as `"completed"` — depth prunes, it does not
	 * stop a run. Default: unlimited.
	 */
	maxDepth?: number;
	/** Stop after this many completed fetches (successes + failures). Default: unlimited. */
	maxPages?: number;
	/** Stop this many ms after `run()` starts. Graceful: in-flight pages drain. Default: unlimited. */
	maxDuration?: number;
	/**
	 * Stop once cumulative response bytes cross this. Checked *after* each completion,
	 * so in-flight responses may overshoot. Default: unlimited.
	 */
	maxTotalBytes?: number;

	// --- behavior ---
	scope?: ScopeOptions;
	/** URL normalization policy — the definition of "the same page". See `./url`. */
	normalize?: NormalizeOptions;
	/** Which link sources to extract from HTML. See `./extract`. */
	extract?: ExtractOptions;
	robots?: RobotsOptions;
	traps?: TrapOptions;
	/**
	 * Additionally enqueue each page's `<link rel=canonical>` target. Default `false` —
	 * the canonical is always *recorded*, it just does not become work.
	 */
	followCanonical?: boolean;
	/**
	 * Enqueue URLs even if the visited store already has them, re-fetching
	 * conditionally (`If-None-Match`/`If-Modified-Since`) where the store holds a body.
	 * Default `false`.
	 */
	recrawl?: boolean;
	/**
	 * Allow URLs resolving to private/loopback/link-local hosts. Default `true`.
	 *
	 * Setting it to `false` turns on a best-effort SSRF guard: it is a **string-only**
	 * check of the hostname and offers no protection against DNS rebinding.
	 */
	allowPrivateHosts?: boolean;
	/** Persistence. Default: in-memory stores, discarded when the run ends. */
	stores?: { frontier?: FrontierStore; visited?: VisitedStore };
	/**
	 * What {@linkcode Crawler.report} keeps in memory. Both default to `false` for
	 * {@linkcode createCrawler} (stream the results instead) and to `true` for
	 * {@linkcode crawl}.
	 */
	collect?: CollectOptions;

	// --- hooks (produce data; a throw fails the page) ---
	/**
	 * Narrow the HTML that **body link discovery** runs over — the escape hatch for
	 * sites whose main content is a `<div class="main">` rather than a `<main>`, where
	 * {@linkcode ScopeOptions.followRegions} has nothing to match on.
	 *
	 * The one-line recipe is a content extractor with a raw-HTML fallback:
	 *
	 * ```ts
	 * beforeExtract: (html) => extractMainContent(html)?.html ?? html
	 * ```
	 *
	 * Three rules, because this hook is easy to get wrong:
	 *
	 * 1. **It narrows link discovery only.** `<head>`-derived data — title, meta-robots,
	 *    `<link rel=canonical|next|prev|alternate>`, meta-refresh — is always read from
	 *    the raw document, which a `<main>`-only narrowing would otherwise destroy.
	 * 2. **It never affects stored bytes.** `contentHash`, `PageResult.size`,
	 *    `ctx.fetchResult` and the `./pg` body archive all keep the raw body.
	 * 3. **A throw is not fatal.** The engine falls back to the raw HTML and warns once
	 *    per crawl — narrowing is an optimization, not a correctness requirement.
	 *
	 * Composes with `followRegions`: narrowing runs first, then region filtering applies
	 * to whatever landmarks remain (usually none, so the whole-document fallback makes
	 * it a no-op — which is the intended outcome).
	 */
	beforeExtract?(html: string, ctx: PageContext): string | Promise<string>;
	/**
	 * Final say on whether to follow a link, called only for links that already passed
	 * every built-in check. Returning `false` records `skipReason: "user"`.
	 */
	shouldVisit?(url: string, ctx: LinkContext): boolean | Promise<boolean>;
	/**
	 * Per completed page, before it is yielded. Its return value lands on
	 * {@linkcode PageResult.data}; `ctx.fetchResult` is the body access path.
	 *
	 * This is the escape hatch for content processing — html→markdown, sanitizing,
	 * embedding, whatever — none of which this package does itself.
	 */
	onPage?(res: PageResult, ctx: PageContext): unknown | Promise<unknown>;
	/** Per extracted link, followed or not. */
	onLink?(link: LinkRecord): void;

	// --- events (observe; a throw is caught and logged) ---
	events?: CrawlEvents;
	/** Throttle for `events.onProgress`, in ms. Default `500`. */
	progressInterval?: number;

	// --- infra ---
	/** Console-compatible logger. Default: none — the library is silent. */
	logger?: Logger;
	/** External cancellation. Firing it is equivalent to calling {@linkcode Crawler.abort}. */
	signal?: AbortSignal;
}

// -----------------------------------------------------------------------------------
// results
// -----------------------------------------------------------------------------------

/**
 * How a URL entered the frontier.
 *
 * There is deliberately no `"redirect"`: a redirect target is an attribute of the item
 * that was already claimed ({@linkcode PageResult.finalUrl} /
 * {@linkcode PageResult.redirects}), never a frontier item of its own.
 */
export type DiscoveredVia = "seed" | "link" | "sitemap" | "canonical" | "manual";

/**
 * The kind of relationship a link expresses. Mirrors `RawLink.rel` from `./extract`,
 * plus `"sitemap"` for URLs that came from a sitemap rather than from markup.
 */
export type LinkRel =
	| "page"
	| "asset"
	| "canonical"
	| "alternate"
	| "next"
	| "prev"
	| "sitemap"
	| "iframe";

/** One recorded edge of the link graph — whether or not it was followed. */
export interface LinkRecord {
	/** Normalized URL of the page the link was found on. */
	from: string;
	/** Normalized absolute target. */
	to: string;
	/** The href exactly as written in the markup. */
	rawHref: string;
	/** Locality of the edge, per the `subdomains` scope mode. */
	kind: "internal" | "external";
	rel: LinkRel;
	nofollow: boolean;
	/**
	 * Innermost sectioning landmark the link was found in, when the markup has one.
	 * Drives {@linkcode ScopeOptions.followRegions}.
	 */
	region?: LinkRegion;
	anchorText?: string;
	followed: boolean;
	/** Present iff `followed` is `false`. */
	skipReason?: SkipReason;
}

/** Argument of {@linkcode CrawlOptions.shouldVisit}. */
export interface LinkContext {
	crawlId: string;
	/** The edge under consideration; its `followed`/`skipReason` are not yet final. */
	link: LinkRecord;
	/** Depth the target would be enqueued at. */
	depth: number;
	referrer: string;
}

/** Argument of {@linkcode CrawlOptions.onPage} and `events.onPageDone`. */
export interface PageContext {
	crawlId: string;
	requestId: string;
	item: FrontierItem;
	/**
	 * The raw page-fetcher result — headers, `text()`, `bytes()`. Undefined when the
	 * fetch failed.
	 *
	 * **This is the body access path.** {@linkcode PageResult} never carries a body.
	 */
	fetchResult?: FetchResult;
	/** Live stats snapshot at the moment this page completed. */
	stats: CrawlStats;
}

/** One completed fetch: success or terminal failure. */
export interface PageResult {
	crawlId: string;
	/** page-fetcher's per-request correlation id — the engine reads it, it does not mint it. */
	requestId: string;
	/** Normalized URL, exactly as it sat in the frontier. */
	url: string;
	/** URL after redirects. Equals {@linkcode url} when there were none. */
	finalUrl: string;
	/** Intermediate redirect URLs, in order. Empty when there were none. */
	redirects: string[];
	status: number;
	ok: boolean;
	contentType?: string;
	charset?: string;
	/** Link distance from the nearest seed (under the default BFS strategy). */
	depth: number;
	/** URL of the page this one was first discovered on. */
	referrer?: string;
	discoveredVia: DiscoveredVia;
	/** Transport attempts made by page-fetcher's retry layer. */
	attempts: number;
	/** ms. `fetch` is page-fetcher's total; `extract` covers link extraction + hooks. */
	timing: { total: number; fetch: number; extract: number };
	/** Response bytes actually read. */
	size?: number;
	/** Served from page-fetcher's cache layer. */
	fromCache: boolean;
	/** Unchanged since the last crawl — either a cache-layer hit or a raw `304`. */
	notModified: boolean;
	/** SHA-256 hex of the raw body bytes, when there was a body. */
	contentHash?: string;
	title?: string;
	/** Normalized `<link rel=canonical>` target, when present. */
	canonical?: string;
	/** Merged `<meta name=robots>` + `X-Robots-Tag`. `noindex` is recorded, not acted on. */
	robots?: { noindex?: boolean; nofollow?: boolean };
	/** Every extracted link, followed or not. */
	links: LinkRecord[];
	/** Present iff the fetch failed terminally. */
	error?: { kind: string; message: string; status?: number; retryable?: boolean };
	/** Whatever {@linkcode CrawlOptions.onPage} returned. */
	data?: unknown;
	/** Echoed from `add()` / seed init. */
	meta?: Record<string, unknown>;
}

/**
 * Why a run ended.
 *
 * `maxDepth` is intentionally absent: it prunes expansion (visible as
 * `skippedByReason["max-depth"]`) and the crawl then finishes normally. A budget that
 * appears here is one that stopped the run.
 */
export type StoppedBy =
	| "completed"
	| "maxPages"
	| "maxDuration"
	| "maxTotalBytes"
	| "stop"
	| "abort";

/**
 * A JSON-serializable snapshot of crawl progress. Deliberately free of `Headers`,
 * functions and class instances — the job/persistence layers write it straight into a
 * JSONB column.
 */
export interface CrawlStats {
	crawlId: string;
	/** Pending frontier items (in-flight excluded). */
	queued: number;
	inFlight: number;
	/** Completed fetches that succeeded. */
	done: number;
	/** Completed fetches that failed terminally. */
	failed: number;
	/** Links rejected before ever becoming work. */
	skipped: number;
	/** Cumulative response bytes — what {@linkcode CrawlOptions.maxTotalBytes} watches. */
	bytes: number;
	startedAt: number;
	elapsed: number;
	pagesPerSecond: number;
	byStatus: Record<number, number>;
	/** Capped to the busiest hosts so the snapshot stays bounded on many-host crawls. */
	byHost?: Record<string, number>;
	skippedByReason: Partial<Record<SkipReason, number>>;
	/** Best-effort ms remaining; only meaningful with {@linkcode CrawlOptions.maxPages}. */
	eta?: number;
}

/**
 * Observation callbacks. Unlike the hooks on {@linkcode CrawlOptions}, a handler that
 * throws here is caught and logged — events never change a crawl's outcome. Async
 * handlers are fire-and-forget: they are not awaited.
 */
export interface CrawlEvents {
	/** `options` is the resolved, post-defaults snapshot. */
	onStart?(
		info: { crawlId: string; seeds: string[]; options: Readonly<CrawlOptions> },
	): void;
	onPageStart?(item: FrontierItem): void;
	/** `ctx.fetchResult` gives body access — this is what a persistence sink consumes. */
	onPageDone?(res: PageResult, ctx: PageContext): void;
	/** Also produces an `onPageDone` whose result carries `error`. */
	onPageError?(err: unknown, item: FrontierItem): void;
	onLinkSkipped?(link: LinkRecord): void;
	/** Throttled to {@linkcode CrawlOptions.progressInterval}, plus one final emit. */
	onProgress?(stats: CrawlStats): void;
	onEnd?(report: CrawlReport): void;
}

/** The end-of-run summary returned by {@linkcode crawl} and {@linkcode Crawler.report}. */
export interface CrawlReport {
	crawlId: string;
	/** Populated only when `collect.pages` was on. */
	pages: PageResult[];
	/** Populated only when `collect.graph` was on. */
	graph: LinkRecord[];
	stats: CrawlStats;
	stoppedBy: StoppedBy;
	/** The `reason` passed to `stop()`/`abort()`, when there was one. */
	stoppedReason?: string;
}

// -----------------------------------------------------------------------------------
// the handle
// -----------------------------------------------------------------------------------

/**
 * A configured, single-use crawl.
 *
 * {@linkcode Crawler.run} is the primary API: an async iterator that applies
 * backpressure, so a slow consumer slows the crawl instead of filling memory.
 */
export interface Crawler {
	/** `crypto.randomUUID()`, minted at creation and stamped on every result and event. */
	readonly crawlId: string;
	/**
	 * Enqueue URLs by hand, before or during a run. Recorded as
	 * `discoveredVia: "manual"` and subject to the same scope checks as any link.
	 */
	add(
		urls: string | string[],
		init?: { depth?: number; meta?: Record<string, unknown> },
	): void;
	/**
	 * Start the crawl and yield results in completion order. **Single-use** — a second
	 * call throws.
	 *
	 * Breaking out of the loop is equivalent to {@linkcode stop}: dispatching ceases,
	 * in-flight pages drain (and are still recorded), and the iterator ends.
	 */
	run(seeds?: string | string[]): AsyncIterableIterator<PageResult>;
	/** Graceful: stop dispatching, let in-flight pages finish, end the iterator. */
	stop(reason?: string): Promise<void>;
	/** Hard: abort in-flight fetches, release their frontier claims, end as soon as possible. */
	abort(reason?: string): void;
	/** Live snapshot. Cheap enough to call in a loop. */
	stats(): CrawlStats;
	/** The final report, or `undefined` while the run is still going. */
	report(): CrawlReport | undefined;
	/** {@linkcode abort} plus disposal of engine-owned fetchers. */
	[Symbol.asyncDispose](): Promise<void>;
}
