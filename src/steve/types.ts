/**
 * The data contracts of `@marianmeres/crawler/steve`: what a crawl-job payload *is*, and
 * what a finished job's `result` holds.
 *
 * One rule shapes all of it. A steve payload is a `Record<string, unknown>` that gets
 * `JSON.stringify`d into a JSONB column, so **nothing function-shaped can ride in it** —
 * no hooks, no fetcher, no stores, no `AbortSignal`, no RegExp patterns. Those are
 * configured code-side on the handler factory, and the payload carries only the data half
 * of {@linkcode CrawlOptions}: budgets, politeness numbers, string patterns, toggles.
 *
 * @module
 */

import type {
	CrawlOptions,
	CrawlStats,
	NormalizeOptions,
	RobotsOptions,
	ScopeOptions,
	StoppedBy,
} from "../types.ts";

/** The job type a crawl is enqueued under, unless the consumer names another one. */
export const CRAWL_JOB_TYPE = "crawl";

/**
 * {@linkcode ScopeOptions} with its two pattern lists narrowed to strings, since a RegExp
 * does not survive `JSON.stringify`. The string arm behaves as it always does — a
 * substring test against the absolute URL. RegExp patterns stay code-side, on the
 * factory's `baseOptions`.
 */
export type SerializableScopeOptions = Omit<ScopeOptions, "include" | "exclude"> & {
	/** Allow-list; a substring miss reports `"excluded"`. */
	include?: string[];
	/** Deny-list; wins over {@linkcode SerializableScopeOptions.include}. */
	exclude?: string[];
};

/**
 * The JSON-serializable subset of {@linkcode CrawlOptions} — the only thing a job payload
 * may carry.
 *
 * Everything function-, store-, fetcher-, signal- or event-typed is omitted and belongs
 * on `createCrawlJobHandler({ baseOptions })` instead; union-typed options keep only their
 * data arm. `collect` is omitted rather than narrowed: job mode streams pages and links
 * into PG and retains nothing, and the handler forces it off.
 *
 * The rule is binding, not the key list: when {@linkcode CrawlOptions} grows a hook it
 * must be added here too, which `tests/steve-types.test.ts` asserts at compile time.
 */
export type SerializableCrawlOptions =
	& Omit<
		CrawlOptions,
		| "fetcher"
		| "stores"
		| "events"
		| "signal"
		| "logger"
		| "beforeExtract"
		| "shouldVisit"
		| "onPage"
		| "onLink"
		| "priority"
		| "scope"
		| "robots"
		| "normalize"
		| "collect"
	>
	& {
		scope?: SerializableScopeOptions;
		/** {@linkcode RobotsOptions} minus its transport override — that stays code-side. */
		robots?: Omit<RobotsOptions, "fetch">;
		/** {@linkcode NormalizeOptions} with string-only `stripParams` (RegExp is code-side). */
		normalize?: Omit<NormalizeOptions, "stripParams"> & { stripParams?: string[] };
		/**
		 * Archive response bodies. Routed to the `./pg` layer — it is
		 * `CrawlerPgOptions.persistBody`, **not** a {@linkcode CrawlOptions} key, and only
		 * its boolean arm is expressible here. The predicate form is code-side, on the
		 * factory's `pg` options.
		 */
		persistBody?: boolean;
	};

/** The payload of one crawl job. */
export interface CrawlJobPayload {
	/** Where the crawl starts. Never empty — `startCrawlJob` rejects that before enqueue. */
	seeds: string[];
	options?: SerializableCrawlOptions;
	/**
	 * Attach this job to an existing crawl run instead of starting a new one — the
	 * documented recovery path for a job the reaper expired.
	 */
	crawlUid?: string;
}

/**
 * What the handler returns, i.e. what steve stringifies into the job's `result` JSONB.
 *
 * A summary and nothing else: pages, the link graph and bodies live in the crawler's own
 * tables and are queried through `./pg`. Putting them here would make every job row carry
 * a copy of the crawl.
 */
export interface CrawlJobResult {
	/** `__crawler_crawl.uid` — the handle to everything this summary leaves out. */
	crawlUid: string;
	stoppedBy: StoppedBy;
	/** Final counters. `byHost` is dropped: unbounded cardinality on a wide crawl. */
	stats: Omit<CrawlStats, "byHost">;
	/** The steve attempt that produced this result. */
	attempt: number;
	/** The attempt continued an existing crawl run rather than starting one. */
	resumed: boolean;
}
