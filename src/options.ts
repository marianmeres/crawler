/**
 * Option resolution: turn a sparse {@linkcode CrawlOptions} into the fully-defaulted,
 * validated shape the engine works with.
 *
 * The defaults documented on {@linkcode CrawlOptions} are *this file* — keeping them in
 * one executable place is what stops the JSDoc from quietly drifting away from the
 * behavior. Unset budgets and trap caps become `Infinity` rather than `undefined`, so
 * every downstream comparison is a plain `>` with no presence check.
 *
 * @module
 */

import { DEFAULT_EXTRACT_OPTIONS } from "./extract/extract-links.ts";
import type {
	CollectOptions,
	CrawlEvents,
	CrawlOptions,
	ExtractOptions,
	Fetcher,
	FetchFn,
	FrontierItem,
	FrontierStore,
	LinkContext,
	Logger,
	NormalizeOptions,
	PageContext,
	PageResult,
	RobotsOptions,
	ScopeOptions,
	TrapOptions,
	VisitedStore,
} from "./types.ts";

/**
 * Default `User-Agent` of the engine-owned fetcher. Honest about what it is and where
 * it comes from — a site owner who wants to block or rate-limit it can.
 */
export const DEFAULT_USER_AGENT =
	"marianmeres-crawler (+https://github.com/marianmeres/crawler)";

/** {@linkcode ScopeOptions} with every field present; `pathPrefix` always an array. */
export type ResolvedScopeOptions =
	& Required<Omit<ScopeOptions, "pathPrefix">>
	& { pathPrefix: string[] };

/** {@linkcode RobotsOptions} with every field present except the transport override. */
export type ResolvedRobotsOptions =
	& Required<Omit<RobotsOptions, "fetch">>
	& { fetch?: FetchFn };

/**
 * The engine's view of the options: no `undefined` where a default exists, no
 * `string | string[]` unions to re-narrow, and unbounded numeric limits spelled
 * `Infinity`.
 */
export interface ResolvedCrawlOptions {
	fetcher?: Fetcher | FetchFn;
	userAgent: string;
	concurrency: number;
	perHostConcurrency: number;
	perHostDelay: number;
	strategy: "bfs" | "dfs" | "priority";
	priority?: (item: FrontierItem) => number;
	maxQueued: number;
	/** `Infinity` when unbounded. */
	maxDepth: number;
	/** `Infinity` when unbounded. */
	maxPages: number;
	/** `Infinity` when unbounded. */
	maxDuration: number;
	/** `Infinity` when unbounded. */
	maxTotalBytes: number;
	scope: ResolvedScopeOptions;
	/** Passed through as given — the `./url` submodule owns its own defaults. */
	normalize: NormalizeOptions;
	extract: Required<ExtractOptions>;
	robots: ResolvedRobotsOptions;
	traps: Required<TrapOptions>;
	followCanonical: boolean;
	recrawl: boolean;
	allowPrivateHosts: boolean;
	stores: { frontier?: FrontierStore; visited?: VisitedStore };
	collect: Required<CollectOptions>;
	beforeExtract?: (html: string, ctx: PageContext) => string | Promise<string>;
	shouldVisit?: (url: string, ctx: LinkContext) => boolean | Promise<boolean>;
	onPage?: (res: PageResult, ctx: PageContext) => unknown | Promise<unknown>;
	onLink?: (link: LinkRecordArg) => void;
	events: CrawlEvents;
	progressInterval: number;
	logger?: Logger;
	signal?: AbortSignal;
}

// (spelled out so the `onLink` signature above stays readable)
type LinkRecordArg = Parameters<NonNullable<CrawlOptions["onLink"]>>[0];

/**
 * Reject a value that is not a number strictly greater than `0`. `Infinity` passes —
 * it is how "no limit" is spelled — but `0`, negatives and `NaN` do not: a cap of zero
 * is never what anyone means, and silently treating it as "unlimited" would be the
 * worst possible reading of it.
 */
function positive(value: number | undefined, name: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || Number.isNaN(value) || value <= 0) {
		throw new TypeError(`[crawler] options.${name} must be > 0 (got ${value})`);
	}
	return value;
}

/** Same, but `0` is meaningful (a delay of none, an interval of none). */
function nonNegative(value: number | undefined, name: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || Number.isNaN(value) || value < 0) {
		throw new TypeError(`[crawler] options.${name} must be >= 0 (got ${value})`);
	}
	return value;
}

/**
 * A cap that counts things, so it must be whole.
 *
 * `Infinity` passes — it is still how "no limit" is spelled — but `2.5` does not. A
 * fractional count has no meaning anywhere it is used (it either sizes an array, bounds
 * a loop, or gates a comparison against an integer), and the alternative to rejecting
 * it is silently rounding on the caller's behalf: `extract.maxLinks: 0.5` would reach
 * `./extract`, fail its own range check, and come back as the default `10_000` — the
 * opposite of what was asked for, with no error anywhere.
 */
function positiveInteger(
	value: number | undefined,
	name: string,
): number | undefined {
	const positiveValue = positive(value, name);
	if (positiveValue === undefined) return undefined;
	if (positiveValue !== Infinity && !Number.isInteger(positiveValue)) {
		throw new TypeError(
			`[crawler] options.${name} must be a whole number (got ${value})`,
		);
	}
	return positiveValue;
}

/** {@linkcode positiveInteger}, for the caps where `0` is meaningful. */
function nonNegativeInteger(
	value: number | undefined,
	name: string,
): number | undefined {
	const nonNegativeValue = nonNegative(value, name);
	if (nonNegativeValue === undefined) return undefined;
	if (nonNegativeValue !== Infinity && !Number.isInteger(nonNegativeValue)) {
		throw new TypeError(
			`[crawler] options.${name} must be a whole number (got ${value})`,
		);
	}
	return nonNegativeValue;
}

/**
 * Apply every documented default and validate the numeric knobs.
 *
 * Validation is deliberately narrow — it catches the mistakes that would otherwise
 * turn into a crawl that quietly does nothing (`concurrency: 0`), a cap that reads as
 * its own opposite (`maxUrlsPerPath: 0`), a count that cannot be one (`maxLinks: 0.5`,
 * which `./extract` would silently replace with its default), or a strategy with no way
 * to sort (`"priority"` without a `priority` function). Everything else is the caller's
 * business. Durations, delays and byte budgets are deliberately *not* required to be
 * whole — half a millisecond is a coherent thing to ask for.
 *
 * @throws {TypeError} on an out-of-range number, a fractional count, or on
 * `strategy: "priority"` without a `priority` function.
 */
export function resolveCrawlOptions(options: CrawlOptions = {}): ResolvedCrawlOptions {
	const strategy = options.strategy ?? "bfs";
	if (strategy === "priority" && typeof options.priority !== "function") {
		throw new TypeError(
			`[crawler] options.strategy "priority" requires options.priority`,
		);
	}

	const scope = options.scope ?? {};
	const extract = options.extract ?? {};
	const robots = options.robots ?? {};
	const traps = options.traps ?? {};
	const collect = options.collect ?? {};

	const pathPrefix = scope.pathPrefix === undefined
		? []
		: Array.isArray(scope.pathPrefix)
		? [...scope.pathPrefix]
		: [scope.pathPrefix];

	// copied for the same reason as pathPrefix: a caller mutating their array
	// afterwards must not reach into a running crawl
	const followRegions = [...(scope.followRegions ?? [])];

	return {
		// transport
		fetcher: options.fetcher,
		userAgent: options.userAgent ?? DEFAULT_USER_AGENT,

		// scheduling
		concurrency: positiveInteger(options.concurrency, "concurrency") ?? 5,
		perHostConcurrency:
			positiveInteger(options.perHostConcurrency, "perHostConcurrency") ??
				2,
		perHostDelay: nonNegative(options.perHostDelay, "perHostDelay") ?? 0,
		strategy,
		priority: options.priority,
		maxQueued: positiveInteger(options.maxQueued, "maxQueued") ?? 100_000,

		// budgets — absent means unbounded
		maxDepth: positiveInteger(options.maxDepth, "maxDepth") ?? Infinity,
		maxPages: positiveInteger(options.maxPages, "maxPages") ?? Infinity,
		maxDuration: positive(options.maxDuration, "maxDuration") ?? Infinity,
		maxTotalBytes: positive(options.maxTotalBytes, "maxTotalBytes") ?? Infinity,

		// behavior
		scope: {
			subdomains: scope.subdomains ?? "same-host",
			include: scope.include ?? [],
			exclude: scope.exclude ?? [],
			pathPrefix,
			allowExternal: scope.allowExternal ?? false,
			checkExternal: scope.checkExternal ?? false,
			followNofollow: scope.followNofollow ?? false,
			followRegions,
			maxUrlLength: positiveInteger(scope.maxUrlLength, "scope.maxUrlLength") ??
				2048,
		},
		normalize: options.normalize ?? {},
		// the values live in ./extract so that a standalone extractLinks() call and a
		// crawl can never disagree about what "default" means; validation stays here
		extract: {
			anchors: extract.anchors ?? DEFAULT_EXTRACT_OPTIONS.anchors,
			canonical: extract.canonical ?? DEFAULT_EXTRACT_OPTIONS.canonical,
			nextPrev: extract.nextPrev ?? DEFAULT_EXTRACT_OPTIONS.nextPrev,
			metaRefresh: extract.metaRefresh ?? DEFAULT_EXTRACT_OPTIONS.metaRefresh,
			alternate: extract.alternate ?? DEFAULT_EXTRACT_OPTIONS.alternate,
			iframes: extract.iframes ?? DEFAULT_EXTRACT_OPTIONS.iframes,
			assets: extract.assets ?? DEFAULT_EXTRACT_OPTIONS.assets,
			srcset: extract.srcset ?? DEFAULT_EXTRACT_OPTIONS.srcset,
			maxAnchorText:
				nonNegativeInteger(extract.maxAnchorText, "extract.maxAnchorText") ??
					DEFAULT_EXTRACT_OPTIONS.maxAnchorText,
			maxLinks: positiveInteger(extract.maxLinks, "extract.maxLinks") ??
				DEFAULT_EXTRACT_OPTIONS.maxLinks,
		},
		robots: {
			respect: robots.respect ?? true,
			sitemaps: robots.sitemaps ?? false,
			crawlDelayCap: nonNegative(robots.crawlDelayCap, "robots.crawlDelayCap") ??
				30_000,
			maxBytes: positiveInteger(robots.maxBytes, "robots.maxBytes") ?? 512_000,
			fetch: robots.fetch,
		},
		traps: {
			maxSegmentRepeat:
				positiveInteger(traps.maxSegmentRepeat, "traps.maxSegmentRepeat") ??
					3,
			maxPathDepth: positiveInteger(traps.maxPathDepth, "traps.maxPathDepth") ?? 20,
			maxQueryParams:
				positiveInteger(traps.maxQueryParams, "traps.maxQueryParams") ?? 32,
			maxUrlsPerPath:
				positiveInteger(traps.maxUrlsPerPath, "traps.maxUrlsPerPath") ?? 200,
			softDupThreshold:
				positiveInteger(traps.softDupThreshold, "traps.softDupThreshold") ??
					10,
		},
		followCanonical: options.followCanonical ?? false,
		recrawl: options.recrawl ?? false,
		allowPrivateHosts: options.allowPrivateHosts ?? true,
		stores: { ...options.stores },
		collect: {
			pages: collect.pages ?? false,
			graph: collect.graph ?? false,
		},

		// hooks + events
		beforeExtract: options.beforeExtract,
		shouldVisit: options.shouldVisit,
		onPage: options.onPage,
		onLink: options.onLink,
		events: options.events ?? {},
		progressInterval: nonNegative(options.progressInterval, "progressInterval") ??
			500,

		// infra
		logger: options.logger,
		signal: options.signal,
	};
}
