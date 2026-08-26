/**
 * {@linkcode startCrawlJob} — the enqueue half of job mode.
 *
 * Nothing here talks to the database directly: the `Jobs` instance the caller owns does
 * the insert, and this is the thin layer that builds a payload the handler will accept and
 * refuses one it would not.
 *
 * @module
 */

import type { JobCreateOptions, Jobs } from "@marianmeres/steve";
import {
	CRAWL_JOB_TYPE,
	type CrawlJobPayload,
	type SerializableCrawlOptions,
} from "./types.ts";

/** {@linkcode JobCreateOptions} plus the two things that are the crawl's, not steve's. */
export interface StartCrawlJobOptions extends JobCreateOptions {
	/** The job type to enqueue under. Defaults to {@linkcode CRAWL_JOB_TYPE}. */
	type?: string;
	/**
	 * Continue an existing crawl run instead of starting one — the documented recovery
	 * path for a job steve's reaper expired. Rides in the payload, not in steve's row.
	 */
	crawlUid?: string;
}

/**
 * Enqueue one crawl as one steve job.
 *
 * ```ts
 * const { uid } = await startCrawlJob(jobs, "https://example.com", { maxPages: 500 });
 * ```
 *
 * `seeds` may be a single URL or a list, and is the one thing validated here: an empty
 * list, a non-string entry or a blank string **throws synchronously**, before `jobs.create`
 * is called. A payload the handler will reject is worth nothing in the queue — it would
 * throw on every attempt and burn all `max_attempts` to arrive at the same error.
 *
 * `options` carries the data half of a crawl's configuration (budgets, politeness numbers,
 * string scope patterns, toggles) and nothing else: it lands in a JSONB column, so hooks,
 * the fetcher, RegExp patterns and `events` are configured code-side on
 * `createCrawlJobHandler` instead. `jobOptions` is passed to steve untouched, so its
 * defaults stand — 3 attempts, exponential backoff, and no attempt timeout.
 *
 * ### Asking how it is going
 *
 * Two questions with two different answers, because steve has no mid-run progress API and
 * writes a job's `result` exactly once, at the end:
 *
 * ```ts
 * // coarse — the queue's view: pending | running | completed | failed | expired
 * const { job } = await jobs.find(uid);
 *
 * // fine — the crawl's own view, live, at any point during the run
 * const crawl = await crawlerPg.getCrawlByJobUid(uid); // __crawler_crawl row
 * crawl?.stats; // { done, failed, skipped, queued, bytes, ... }
 * // per-URL detail and page-level errors: the ./pg query API over __crawler_page
 *
 * // and once it is over, the small summary: job.result as CrawlJobResult
 * ```
 *
 * A finished job's `result` is a `CrawlJobResult` — counters and a `crawlUid`, never pages
 * and never bodies. Those live in the crawler's own tables, and so does the crawl history:
 * steve rows are queue plumbing, and `jobs.fetchAll()` only lists the last 30 minutes of
 * them by default.
 *
 * @param jobs A live, caller-owned `Jobs` instance — steve is a type-only dependency here.
 * @param seeds Where the crawl starts. A single URL or a non-empty list of them.
 * @param options The JSON-serializable subset of `CrawlOptions`.
 * @param jobOptions steve's own `JobCreateOptions`, plus `type` and `crawlUid`.
 * @returns The uid of the created job — the handle for `jobs.find` and `getCrawlByJobUid`.
 */
export function startCrawlJob(
	jobs: Jobs,
	seeds: string | string[],
	options?: SerializableCrawlOptions,
	jobOptions?: StartCrawlJobOptions,
): Promise<{ uid: string }> {
	const { type = CRAWL_JOB_TYPE, crawlUid, ...createOptions } = jobOptions ?? {};

	const payload: CrawlJobPayload = {
		seeds: normalizeSeeds(seeds),
		...(options === undefined ? {} : { options }),
		...(crawlUid === undefined ? {} : { crawlUid }),
	};

	return jobs
		.create(type, { ...payload }, createOptions)
		.then((job) => ({ uid: job.uid }));
}

function normalizeSeeds(seeds: string | string[]): string[] {
	const list = typeof seeds === "string" ? [seeds] : seeds;
	if (
		!Array.isArray(list) || list.length === 0 ||
		!list.every((seed) => typeof seed === "string" && seed.trim() !== "")
	) {
		throw new TypeError(
			"[crawler/steve] startCrawlJob needs a non-empty seed URL, or a non-empty " +
				"array of them",
		);
	}
	return list;
}
