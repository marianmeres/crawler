/**
 * The PostgreSQL {@linkcode FrontierStore} / {@linkcode VisitedStore}, each bound to one
 * crawl row. Constructed by `createCrawl`/`openCrawl`; a consumer reaches them through
 * `CrawlPersistence.stores`.
 *
 * Two properties are worth knowing before reading the SQL:
 *
 * 1. **The frontier table is the dedup set.** `push` is a plain
 *    `ON CONFLICT (crawl_id, url) DO NOTHING` — the conflict target *is* the "already
 *    seen this run" question, so dedup is atomic without a second round trip, and
 *    `rowCount` is the answer.
 * 2. **The visited store spans runs.** `has`/`count` read this crawl's frontier rows,
 *    but `get`/`add` read and write `__crawler_url`, which is per `(tenant_id, url)` and
 *    outlives every crawl. That split is what makes an incremental re-crawl possible: a
 *    fresh run starts with an empty frontier and a full archive of validators.
 *
 * @module
 */

import type { FrontierItem, FrontierStore } from "../stores/types.ts";
import type { VisitedState, VisitedStore } from "../stores/types.ts";
// type-only, and `crawler-pg.ts` imports the classes below as values: the cycle is
// erased at compile time, exactly as in `../stores/types.ts`
import type { CrawlerContext } from "./crawler-pg.ts";
import { getBody } from "./query.ts";
import type { ArchivedBody } from "./query.ts";

/** Epoch ms → `TIMESTAMPTZ`, with a NULL that COALESCEs to the column's default. */
const AS_TIMESTAMP = (param: string) =>
	`to_timestamp(${param}::double precision / 1000.0)`;

/** Never throws: `host` is `NOT NULL`, and a URL this store cannot parse is not worth one. */
function hostOf(url: string): string {
	try {
		return new URL(url).hostname;
	} catch {
		return "";
	}
}

// deno-lint-ignore no-explicit-any -- a pg result row is untyped by construction
function toFrontierItem(row: any): FrontierItem {
	const item: FrontierItem = {
		url: row.url,
		host: row.host,
		depth: row.depth,
		priority: row.priority,
		// the serial `id` reproduces insertion order (the engine pushes serially), so it
		// stands in for the engine-side `seq` everywhere ordering matters
		seq: row.id,
		discoveredVia: row.discovered_via,
		readyAt: (row.ready_at as Date).getTime(),
	};
	if (row.referrer !== null) item.referrer = row.referrer;
	if (row.meta !== null) item.meta = row.meta;
	return item;
}

/**
 * The frontier of one crawl row: a claim/ack queue over `__crawler_frontier`.
 *
 * Rows are kept after the crawl ends — they are both the dedup memory and the audit of
 * what was enqueued. `CrawlerPg.deleteCrawl` cascades them away.
 *
 * @internal
 */
export class PgFrontierStore implements FrontierStore {
	#ctx: CrawlerContext;
	#crawlId: number;

	constructor(ctx: CrawlerContext, crawlId: number) {
		this.#ctx = ctx;
		this.#crawlId = crawlId;
	}

	get #t() {
		return this.#ctx.tableNames.tableFrontier;
	}

	async push(item: FrontierItem): Promise<boolean> {
		await this.#ctx.ready();
		const { rowCount } = await this.#ctx.db.query(
			`INSERT INTO ${this.#t}
				(tenant_id, crawl_id, url, host, depth, priority, discovered_via,
					referrer, meta, ready_at)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb,
					COALESCE(${AS_TIMESTAMP("$10")}, NOW()))
				ON CONFLICT (crawl_id, url) DO NOTHING`,
			[
				this.#ctx.tenantId,
				this.#crawlId,
				item.url,
				item.host,
				item.depth,
				item.priority,
				item.discoveredVia,
				item.referrer ?? null,
				item.meta === undefined ? null : JSON.stringify(item.meta),
				item.readyAt ?? null,
			],
		);
		return rowCount === 1;
	}

	/**
	 * `FOR UPDATE SKIP LOCKED` inside the claiming `UPDATE`: two workers popping at the
	 * same instant take two different rows instead of blocking on one.
	 *
	 * `filter.now` is ignored — it exists so the memory store can be tested against a
	 * fixed clock, and a fixed clock is not something a database shares.
	 */
	async pop(
		filter?: { excludeHosts?: readonly string[]; now?: number },
	): Promise<FrontierItem | undefined> {
		await this.#ctx.ready();
		const { rows } = await this.#ctx.db.query(
			`UPDATE ${this.#t} SET status = 'in_flight', claimed_at = NOW()
				WHERE id = (
					SELECT id FROM ${this.#t}
					WHERE crawl_id = $1 AND status = 'pending'
						AND ready_at <= NOW()
						AND (cardinality($2::text[]) = 0 OR host <> ALL($2::text[]))
					ORDER BY priority, id
					FOR UPDATE SKIP LOCKED
					LIMIT 1
				)
				RETURNING *`,
			// an empty array, never NULL: `host <> ALL(NULL)` is NULL, which would filter
			// out every row instead of none
			[this.#crawlId, [...(filter?.excludeHosts ?? [])]],
		);
		return rows.length ? toFrontierItem(rows[0]) : undefined;
	}

	async ack(url: string): Promise<void> {
		await this.#ctx.ready();
		await this.#ctx.db.query(
			`UPDATE ${this.#t} SET status = 'done'
				WHERE crawl_id = $1 AND url = $2`,
			[this.#crawlId, url],
		);
	}

	/**
	 * The `in_flight` guard is what makes this a no-op on anything that is not a live
	 * claim — the memory store is tolerant the same way, and without it a stray
	 * `release` of a finished URL would resurrect it into the queue.
	 */
	async release(url: string, readyAt?: number): Promise<void> {
		await this.#ctx.ready();
		await this.#ctx.db.query(
			`UPDATE ${this.#t}
				SET status = 'pending',
					claimed_at = NULL,
					ready_at = COALESCE(${AS_TIMESTAMP("$3")}, NOW())
				WHERE crawl_id = $1 AND url = $2 AND status = 'in_flight'`,
			[this.#crawlId, url, readyAt ?? null],
		);
	}

	async size(): Promise<number> {
		await this.#ctx.ready();
		const { rows } = await this.#ctx.db.query(
			`SELECT count(*)::int AS count FROM ${this.#t}
				WHERE crawl_id = $1 AND status = 'pending'`,
			[this.#crawlId],
		);
		return rows[0].count;
	}
}

/**
 * The visited set of one crawl row, over this run's frontier rows and the cross-run
 * `__crawler_url` archive.
 *
 * Unlike the memory store, {@linkcode VisitedState.hasBody} here is the truth — this
 * store can hold bodies, so a re-crawl may send conditional headers and act on a `304`.
 *
 * @internal
 */
export class PgVisitedStore implements VisitedStore {
	#ctx: CrawlerContext;
	#crawlId: number;

	constructor(ctx: CrawlerContext, crawlId: number) {
		this.#ctx = ctx;
		this.#crawlId = crawlId;
	}

	/** "Enqueued or processed in this run", in any status — the cheap pre-check. */
	async has(url: string): Promise<boolean> {
		await this.#ctx.ready();
		const { rows } = await this.#ctx.db.query(
			`SELECT EXISTS (
					SELECT 1 FROM ${this.#ctx.tableNames.tableFrontier}
					WHERE crawl_id = $1 AND url = $2
				) AS found`,
			[this.#crawlId, url],
		);
		return rows[0].found === true;
	}

	/**
	 * Two writes, and the second one is the subtle half.
	 *
	 * The archive upsert **replaces** rather than merges, like the memory store: the last
	 * completion is the truth about a URL, and a redirect intermediate's minimal record
	 * must not be able to leave a stale validator behind. The body is never touched here —
	 * that is `persistPage`'s job.
	 *
	 * The frontier `done` row exists for URLs marked visited without ever being enqueued
	 * (the engine records every redirect hop). Without it {@linkcode has} would miss them
	 * and another referrer would re-fetch the same bytes. For a completed page the row is
	 * already there and the insert no-ops.
	 */
	async add(url: string, state: VisitedState): Promise<void> {
		await this.#ctx.ready();
		await this.#ctx.db.query(
			`INSERT INTO ${this.#ctx.tableNames.tableUrl}
				(tenant_id, url, etag, last_modified, content_hash, last_status, fetched_at)
				VALUES ($1, $2, $3, $4, $5, $6, COALESCE(${AS_TIMESTAMP("$7")}, NOW()))
				ON CONFLICT (tenant_id, url) DO UPDATE SET
					etag = EXCLUDED.etag,
					last_modified = EXCLUDED.last_modified,
					content_hash = EXCLUDED.content_hash,
					last_status = EXCLUDED.last_status,
					fetched_at = EXCLUDED.fetched_at`,
			[
				this.#ctx.tenantId,
				url,
				state.etag ?? null,
				state.lastModified ?? null,
				state.contentHash ?? null,
				state.status ?? null,
				state.crawledAt ?? null,
			],
		);
		await this.#ctx.db.query(
			`INSERT INTO ${this.#ctx.tableNames.tableFrontier}
				(tenant_id, crawl_id, url, host, status)
				VALUES ($1, $2, $3, $4, 'done')
				ON CONFLICT (crawl_id, url) DO NOTHING`,
			[this.#ctx.tenantId, this.#crawlId, url, hostOf(url)],
		);
	}

	/**
	 * The archive row, plus `attempts` from this run's page row when one was persisted —
	 * `attempts` is per-run by nature and `__crawler_url` keeps no such column, so a URL
	 * that only ever went through {@linkcode add} reports none.
	 */
	async get(url: string): Promise<VisitedState | undefined> {
		await this.#ctx.ready();
		const { rows } = await this.#ctx.db.query(
			`SELECT u.last_status, u.content_hash, u.etag, u.last_modified, u.fetched_at,
					(u.body IS NOT NULL) AS has_body, p.attempts
				FROM ${this.#ctx.tableNames.tableUrl} u
				LEFT JOIN ${this.#ctx.tableNames.tablePage} p
					ON p.crawl_id = $3 AND p.url = u.url
				WHERE u.tenant_id = $1 AND u.url = $2`,
			[this.#ctx.tenantId, url, this.#crawlId],
		);
		if (!rows.length) return undefined;

		const row = rows[0];
		const state: VisitedState = { hasBody: row.has_body === true };
		if (row.last_status !== null) state.status = row.last_status;
		if (row.content_hash !== null) state.contentHash = row.content_hash;
		if (row.etag !== null) state.etag = row.etag;
		if (row.last_modified !== null) state.lastModified = row.last_modified;
		if (row.fetched_at !== null) {
			state.crawledAt = (row.fetched_at as Date).getTime();
		}
		if (row.attempts !== null && row.attempts !== undefined) {
			state.attempts = row.attempts;
		}
		return state;
	}

	async count(): Promise<number> {
		await this.#ctx.ready();
		const { rows } = await this.#ctx.db.query(
			`SELECT count(*)::int AS count FROM ${this.#ctx.tableNames.tableFrontier}
				WHERE crawl_id = $1 AND status = 'done'`,
			[this.#crawlId],
		);
		return rows[0].count;
	}

	/**
	 * The archived bytes — the other half of {@linkcode VisitedState.hasBody}, and the
	 * reason an incremental re-crawl can traverse a site it did not re-download.
	 */
	getBody(url: string): Promise<ArchivedBody | null> {
		return getBody(this.#ctx, url);
	}
}
