/**
 * `@marianmeres/crawler/steve` — a whole crawl as one `@marianmeres/steve` job.
 *
 * ONE CRAWL = ONE JOB. steve gives the crawl a durable queue entry, retry-with-backoff
 * and a `find(uid)` status check. Everything per-URL — live progress, pages, bodies, the
 * link graph — lives in the crawler's own PG tables and is read through
 * `@marianmeres/crawler/pg`, because steve has no mid-run progress API and writes a job's
 * `result` exactly once, at the end. That asymmetry is the whole design.
 *
 * steve is a **type-only** dependency here: this submodule never constructs a queue, the
 * consumer passes a live `Jobs` instance in. Job mode always runs on the PG stores —
 * retry has nowhere else to resume from.
 *
 * ```ts
 * // worker.ts — the process that runs the crawls
 * import pg from "pg";
 * import { Jobs } from "@marianmeres/steve";
 * import { CRAWL_JOB_TYPE, createCrawlJobHandler } from "@marianmeres/crawler/steve";
 *
 * const db = new pg.Pool({ connectionString: Deno.env.get("DATABASE_URL") });
 *
 * const jobs = new Jobs({
 *     db,
 *     // a prefix of its own: any worker started on a prefix claims its jobs, and one
 *     // without the crawl handler would noop-complete them
 *     tablePrefix: "crawlq",
 *     jobHandlers: {
 *         [CRAWL_JOB_TYPE]: createCrawlJobHandler({
 *             db,
 *             pg: { tablePrefix: "crawlq" },
 *             baseOptions: {
 *                 maxDuration: 30 * 60_000, // always budget a job-mode crawl
 *                 onPage: (res) => ({ title: res.title }), // code-side; never in a payload
 *             },
 *         }),
 *     },
 *     // MUST cover every attempt plus backoff, not one crawl — the default is 5 minutes
 *     autoCleanup: { maxAllowedRunDurationMinutes: 120 },
 * });
 *
 * await jobs.start(2);
 * ```
 *
 * ```ts
 * // anywhere — enqueue, then watch the crawler's own tables for progress
 * import { startCrawlJob } from "@marianmeres/crawler/steve";
 *
 * const { uid } = await startCrawlJob(jobs, "https://example.com", { maxPages: 500 });
 *
 * const { job } = await jobs.find(uid);              // pending | running | completed | …
 * const crawl = await crawlerPg.getCrawlByJobUid(uid); // live counters, mid-run
 * ```
 *
 * Two things about the `Jobs` instance decide whether this works in production, and neither
 * is visible from inside the handler: how its reaper is configured, and which workers claim
 * from its prefix. Both are documented on {@linkcode createCrawlJobHandler}.
 *
 * @module
 */

export { createCrawlJobHandler } from "./handler.ts";
export type { CreateCrawlJobHandlerOptions } from "./handler.ts";

export { startCrawlJob } from "./start.ts";
export type { StartCrawlJobOptions } from "./start.ts";

export { CRAWL_JOB_TYPE } from "./types.ts";

export type {
	CrawlJobPayload,
	CrawlJobResult,
	SerializableCrawlOptions,
	SerializableScopeOptions,
} from "./types.ts";
