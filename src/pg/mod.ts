/**
 * `@marianmeres/crawler/pg` — PostgreSQL persistence for a crawl.
 *
 * Inject an open connection and the submodule owns the rest: it installs its own five
 * tables on first use, so there is no migration step to run and nothing to keep in sync.
 *
 * ```ts
 * import pg from "pg";
 * import { createCrawlerPg } from "@marianmeres/crawler/pg";
 *
 * const crawlerPg = createCrawlerPg({ db: new pg.Pool({ ... }) });
 * const run = await crawlerPg.createCrawl({ seeds: ["https://example.com"] });
 *
 * await run.markRunning();
 * // … crawl …
 * await run.markEnded({ status: "completed" });
 * ```
 *
 * Everything is scoped to a `tenantId` (default `"_default"`) and prefixed by an optional
 * `tablePrefix`, which may carry a schema — `"myschema."` puts the whole set in
 * `myschema`.
 *
 * @module
 */

export { CrawlerPg, createCrawlerPg, DEFAULT_TENANT_ID } from "./crawler-pg.ts";

export type {
	CrawlerPgOptions,
	CrawlPersistence,
	CrawlRow,
	CrawlStatus,
} from "./crawler-pg.ts";

export type { ArchivedBody, BrokenLink, ChangedUrl, LinkRow, PageRow } from "./query.ts";

// so a consumer can type a logger without importing page-fetcher themselves
export type { Logger } from "../types.ts";
