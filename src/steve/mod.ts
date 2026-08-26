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
 * @module
 */

export { CRAWL_JOB_TYPE } from "./types.ts";

export type {
	CrawlJobPayload,
	CrawlJobResult,
	SerializableCrawlOptions,
	SerializableScopeOptions,
} from "./types.ts";
