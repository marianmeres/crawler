/**
 * {@linkcode CrawlerPg} — the `./pg` entry point: one object owning the injected
 * connection, the table prefix, the tenant scope and the lazy schema install, handing out
 * per-crawl bound handles.
 *
 * Two conventions carried over from the sibling `@marianmeres` PG packages:
 *
 * 1. **The connection is injected, never opened here.** `pg` is a type-only import, so
 *    this package pulls the driver into a consumer's graph only if they were using it
 *    anyway. Inject a `pg.Pool`; a `pg.Client` works but serializes transactions on its
 *    single socket, which throttles a `concurrency > 1` crawl.
 * 2. **There is no migration step to run.** The schema installs itself, once per
 *    instance, at the top of the first public DB method — see `#initOnce()`.
 *
 * @module
 */

import type pg from "pg";
import type { CrawlStats, FetchResult, Logger, PageResult, StoppedBy } from "../types.ts";
import type { FrontierStore, VisitedStore } from "../stores/types.ts";
import { PgFrontierStore, PgVisitedStore } from "./stores.ts";
import { persistPage } from "./persist.ts";
import {
	_initialize,
	_schemaCreate,
	_schemaDrop,
	_tableNames,
	_uninstall,
	type CrawlerTableNames,
} from "./_schema.ts";
import { isPool, type Queryable, withTransaction } from "./utils/with-transaction.ts";
import * as query from "./query.ts";
import type { ArchivedBody, BrokenLink, ChangedUrl, LinkRow, PageRow } from "./query.ts";

/** The tenant every row falls into when the consumer is not multi-tenant. */
export const DEFAULT_TENANT_ID = "_default";

/** The lifecycle of one crawl row. Mirrors the column's CHECK constraint. */
export type CrawlStatus = "pending" | "running" | "completed" | "failed" | "stopped";

export interface CrawlerPgOptions {
	/**
	 * An open `pg.Pool` (recommended) or `pg.Client`. Owned by the caller: this package
	 * never opens or closes it.
	 */
	db: pg.Pool | pg.Client;
	/**
	 * Prepended to every table name. May carry a schema — `"myschema."` puts the whole
	 * five-table set in `myschema`. Default `""`.
	 */
	tablePrefix?: string;
	/** Row-level isolation for every read and write. Default {@linkcode DEFAULT_TENANT_ID}. */
	tenantId?: string;
	/**
	 * Archive the response body in `__crawler_url`. Default `true`.
	 *
	 * The predicate form is the size/cost knob — `(res) => res.contentType === "text/html"`
	 * keeps the pages worth diffing and skips the PDFs. Whatever it says, a body is only
	 * ever written for an ok response that retained one.
	 *
	 * Turning it off is not free: an incremental re-crawl only sends conditional headers
	 * where a body is stored (that is the rule that removes the "304 with nothing to fall
	 * back on" corner), so a bodyless URL is always re-fetched in full.
	 */
	persistBody?: boolean | ((res: PageResult) => boolean);
	/**
	 * The floor between two {@linkcode CrawlPersistence.progress} writes, in ms.
	 * Default `1000`, `0` writes every call.
	 */
	progressThrottleMs?: number;
	/** Silent when absent. */
	logger?: Logger;
}

/** One `__crawler_crawl` row, camelCased. */
export interface CrawlRow {
	id: number;
	uid: string;
	tenantId: string;
	seeds: string[];
	/** The JSON-safe snapshot handed to {@linkcode CrawlerPg.createCrawl}. */
	options: Record<string, unknown>;
	status: CrawlStatus;
	/** `{}` until the first progress write. */
	stats: Partial<CrawlStats>;
	stoppedBy: StoppedBy | null;
	error: string | null;
	jobUid: string | null;
	startedAt: Date | null;
	endedAt: Date | null;
	createdAt: Date;
	updatedAt: Date;
}

/** A {@linkcode CrawlerPg} bound to one crawl row. */
export interface CrawlPersistence {
	/** Refreshed by every lifecycle write on this handle. */
	readonly crawl: CrawlRow;
	/**
	 * This crawl's durable frontier and visited set — hand them to `crawl()` as
	 * `options.stores` and the run survives the process that started it.
	 */
	readonly stores: { frontier: FrontierStore; visited: VisitedStore };
	/**
	 * Writes one completed page — the URL archive (body included), the per-run page row,
	 * this page's outgoing edges and the frontier ack — in a single transaction.
	 *
	 * Wire it straight to an `onPageDone` event or to the `run()` loop; the signature is
	 * that callback's, and `ctx` is only read for its `fetchResult`, the body access path.
	 *
	 * Replaying it on the same result is safe by construction: every write is an upsert or
	 * a replace, so a retried job re-persists rather than duplicating.
	 *
	 * `res.data` — whatever `onPage` returned — must be plain JSON-serializable data. A
	 * value that is not (a `BigInt`, most notably) is stored as `NULL` with one logged
	 * warning; it never fails the page.
	 */
	persistPage(res: PageResult, ctx?: { fetchResult?: FetchResult }): Promise<void>;
	/**
	 * Publishes a live snapshot into `__crawler_crawl.stats`, which is the only way to
	 * watch a long crawl from another process.
	 *
	 * Wire it straight to `events.onProgress`: writes are throttled to one per
	 * {@linkcode CrawlerPgOptions.progressThrottleMs} per handle, calls inside that window
	 * resolve at once and the last of them is flushed when the window elapses. A failing
	 * write is logged and swallowed — progress never fails a crawl.
	 */
	progress(stats: CrawlStats): Promise<void>;
	/**
	 * `pending` (or a resumed `failed`/`stopped`) → `running`. The first call stamps
	 * `startedAt`; later ones keep it, so a resumed attempt reports the original start.
	 */
	markRunning(): Promise<void>;
	/**
	 * Terminal, and it force-writes past the progress throttle: `stats` when given,
	 * otherwise a snapshot the throttle was still holding, otherwise the stored one.
	 */
	markEnded(end: {
		status: "completed" | "failed" | "stopped";
		stoppedBy?: StoppedBy;
		error?: string;
		stats?: CrawlStats;
	}): Promise<void>;
}

/**
 * What a bound handle — and the stores it hands out — need from their owning
 * {@linkcode CrawlerPg}.
 *
 * @internal
 */
export interface CrawlerContext {
	db: Queryable;
	tableNames: CrawlerTableNames;
	tenantId: string;
	/** Resolved to a value: the option's `undefined` means `true`. */
	persistBody: boolean | ((res: PageResult) => boolean);
	/** Resolved to a non-negative number. */
	progressThrottleMs: number;
	logger?: Logger;
	/** Resolves once the schema is installed; every DB method awaits it first. */
	ready(): Promise<void>;
	/** One BEGIN/COMMIT around `fn`, on its own pooled client. */
	transaction<T>(fn: (client: Queryable) => Promise<T>): Promise<T>;
}

class CrawlHandle implements CrawlPersistence {
	#ctx: CrawlerContext;
	#row: CrawlRow;
	readonly stores: { frontier: FrontierStore; visited: VisitedStore };
	/**
	 * Throttle state, per handle and never shared: two crawls running on one
	 * {@linkcode CrawlerPg} must not consume each other's window.
	 */
	#lastProgressAt = 0;
	#pendingStats: CrawlStats | null = null;
	#progressTimer: ReturnType<typeof setTimeout> | undefined;
	#ended = false;

	constructor(ctx: CrawlerContext, row: CrawlRow) {
		this.#ctx = ctx;
		this.#row = row;
		this.stores = {
			frontier: new PgFrontierStore(ctx, row.id),
			visited: new PgVisitedStore(ctx, row.id),
		};
	}

	get crawl(): CrawlRow {
		return this.#row;
	}

	persistPage(res: PageResult, ctx?: { fetchResult?: FetchResult }): Promise<void> {
		return persistPage(this.#ctx, this.#row.id, res, ctx?.fetchResult);
	}

	async progress(stats: CrawlStats): Promise<void> {
		const wait = this.#lastProgressAt + this.#ctx.progressThrottleMs - Date.now();
		if (wait <= 0 && this.#progressTimer === undefined) {
			await this.#writeStats(stats);
			return;
		}
		this.#pendingStats = stats;
		this.#progressTimer ??= setTimeout(() => {
			this.#progressTimer = undefined;
			const pending = this.#pendingStats;
			this.#pendingStats = null;
			if (pending) void this.#writeStats(pending);
		}, wait);
	}

	/** Never throws: see {@linkcode CrawlPersistence.progress}. */
	async #writeStats(stats: CrawlStats): Promise<void> {
		// a snapshot that lost the race to markEnded would resurrect a mid-run count
		if (this.#ended) return;
		this.#lastProgressAt = Date.now();
		try {
			await this.#ctx.ready();
			const { rows } = await this.#ctx.db.query(
				`UPDATE ${this.#ctx.tableNames.tableCrawl}
					SET stats = $2::jsonb, updated_at = NOW()
					WHERE id = $1
					RETURNING *`,
				[this.#row.id, JSON.stringify(stats)],
			);
			if (rows[0]) this.#row = query._toCrawlRow(rows[0]);
		} catch (e) {
			this.#ctx.logger?.warn(`Crawl progress write failed: ${e}`);
		}
	}

	/** Drops the throttle's trailing write, returning the snapshot it was holding. */
	#takePendingStats(): CrawlStats | null {
		clearTimeout(this.#progressTimer);
		this.#progressTimer = undefined;
		const pending = this.#pendingStats;
		this.#pendingStats = null;
		return pending;
	}

	async markRunning(): Promise<void> {
		await this.#ctx.ready();
		const { rows } = await this.#ctx.db.query(
			`UPDATE ${this.#ctx.tableNames.tableCrawl}
				SET status = 'running',
					started_at = COALESCE(started_at, NOW()),
					updated_at = NOW()
				WHERE id = $1
				RETURNING *`,
			[this.#row.id],
		);
		this.#row = query._toCrawlRow(rows[0]);
	}

	async markEnded(end: {
		status: "completed" | "failed" | "stopped";
		stoppedBy?: StoppedBy;
		error?: string;
		stats?: CrawlStats;
	}): Promise<void> {
		const pending = this.#takePendingStats();
		const finalStats = end.stats ?? pending;
		this.#ended = true;
		await this.#ctx.ready();
		const { rows } = await this.#ctx.db.query(
			`UPDATE ${this.#ctx.tableNames.tableCrawl}
				SET status = $2,
					stopped_by = $3,
					error = $4,
					stats = COALESCE($5::jsonb, stats),
					ended_at = NOW(),
					updated_at = NOW()
				WHERE id = $1
				RETURNING *`,
			[
				this.#row.id,
				end.status,
				end.stoppedBy ?? null,
				end.error ?? null,
				finalStats ? JSON.stringify(finalStats) : null,
			],
		);
		this.#row = query._toCrawlRow(rows[0]);
	}
}

export class CrawlerPg {
	#db: pg.Pool | pg.Client;
	#tableNames: CrawlerTableNames;
	#tenantId: string;
	#logger?: Logger;
	#ctx: CrawlerContext;
	#initialized = false;
	#init: Promise<void> | null = null;

	constructor(options: CrawlerPgOptions) {
		if (!options?.db) {
			throw new TypeError("CrawlerPg needs a `db` (a pg.Pool or a pg.Client)");
		}
		this.#db = options.db;
		this.#tableNames = _tableNames(options.tablePrefix ?? "");
		this.#tenantId = options.tenantId ?? DEFAULT_TENANT_ID;
		this.#logger = options.logger;

		if (!isPool(options.db)) {
			this.#logger?.debug(
				"CrawlerPg: `db` is a pg.Client, so transactions run one at a time on " +
					"its single connection — inject a pg.Pool for concurrency > 1",
			);
		}

		this.#ctx = {
			db: this.#db as Queryable,
			tableNames: this.#tableNames,
			tenantId: this.#tenantId,
			persistBody: options.persistBody ?? true,
			progressThrottleMs: Math.max(0, options.progressThrottleMs ?? 1000),
			logger: this.#logger,
			ready: () => this.#initOnce(),
			transaction: (fn) => withTransaction(this.#db, (client) => fn(client)),
		};
	}

	/** `pg.Pool` and `pg.Client` declare structurally incompatible `query` overloads. */
	// deno-lint-ignore no-explicit-any -- a pg result row is untyped by construction
	#query(text: string, values?: unknown[]): Promise<any> {
		return (this.#db as Queryable).query(text, values);
	}

	/**
	 * The whole install story: no ledger, no migration command, just the idempotent
	 * create blob run once per instance and re-run by {@linkcode CrawlerPg.resetHard}.
	 * Concurrent first callers share the one in-flight install; a failed one is not
	 * cached, so the next call retries.
	 */
	async #initOnce(hard = false): Promise<void> {
		if (this.#initialized && !hard) return;
		if (!this.#init || hard) {
			this.#init = _initialize({ db: this.#db, tableNames: this.#tableNames }, hard)
				.then(() => {
					this.#initialized = true;
				})
				.catch((e) => {
					this.#init = null;
					throw e;
				});
		}
		await this.#init;
	}

	/** Inserts a `pending` crawl row and binds a handle to it. */
	async createCrawl(input: {
		/** Default `crypto.randomUUID()`. Must be a UUID — the column is one. */
		uid?: string;
		seeds: string[];
		/** Stored verbatim in the `options` JSONB; the caller passes a JSON-safe subset. */
		options?: Record<string, unknown>;
		/** The `@marianmeres/steve` job this crawl runs under, in job mode. */
		jobUid?: string;
	}): Promise<CrawlPersistence> {
		await this.#initOnce();
		const { rows } = await this.#query(
			`INSERT INTO ${this.#tableNames.tableCrawl}
				(uid, tenant_id, seeds, options, job_uid, status)
				VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, 'pending')
				RETURNING *`,
			[
				input.uid ?? crypto.randomUUID(),
				this.#tenantId,
				JSON.stringify(input.seeds ?? []),
				JSON.stringify(input.options ?? {}),
				input.jobUid ?? null,
			],
		);
		return new CrawlHandle(this.#ctx, query._toCrawlRow(rows[0]));
	}

	/**
	 * Binds a handle to an existing crawl row. Throws when there is none.
	 *
	 * This is also the resume path, so it recovers the frontier first: whatever a crashed
	 * (or reaped) attempt left `in_flight` goes back to `pending`, because nobody is going
	 * to ack it. Safe because one crawl runs in one process at a time — see the caveat on
	 * the steve handler's run-duration limit. The recovered URLs get re-fetched and
	 * `persistPage`'s upserts absorb the replay.
	 */
	async openCrawl(uid: string): Promise<CrawlPersistence> {
		await this.#initOnce();
		const { rows } = await this.#query(
			`SELECT * FROM ${this.#tableNames.tableCrawl}
				WHERE tenant_id = $1 AND uid = $2`,
			[this.#tenantId, uid],
		);
		if (!rows.length) {
			throw new Error(`Crawl '${uid}' not found (tenant '${this.#tenantId}')`);
		}
		const row = query._toCrawlRow(rows[0]);
		await this.#query(
			`UPDATE ${this.#tableNames.tableFrontier}
				SET status = 'pending', claimed_at = NULL
				WHERE crawl_id = $1 AND status = 'in_flight'`,
			[row.id],
		);
		return new CrawlHandle(this.#ctx, row);
	}

	// -------------------------------------------------------------------------------
	// reporting — see `./query.ts`
	// -------------------------------------------------------------------------------

	/** One crawl by its `uid`, or `null`. */
	getCrawl(uid: string): Promise<CrawlRow | null> {
		return query.getCrawl(this.#ctx, uid);
	}

	/**
	 * The crawl a `@marianmeres/steve` job produced, or `null`. This is the job-mode
	 * bridge: a retried attempt looks its predecessor up here and resumes it instead of
	 * starting over. The newest wins if a job somehow created more than one.
	 */
	getCrawlByJobUid(jobUid: string): Promise<CrawlRow | null> {
		return query.getCrawlByJobUid(this.#ctx, jobUid);
	}

	/** This tenant's crawls, newest first. */
	listCrawls(
		opts?: { status?: CrawlStatus; limit?: number; offset?: number },
	): Promise<CrawlRow[]> {
		return query.listCrawls(this.#ctx, opts);
	}

	/**
	 * Just the `stats` JSONB — the cheap poll for watching a running crawl from another
	 * process. `{}` until the first progress write lands, `null` when there is no such
	 * crawl.
	 */
	crawlStats(uid: string): Promise<Partial<CrawlStats> | null> {
		return query.crawlStats(this.#ctx, uid);
	}

	/**
	 * The pages of one crawl, in discovery order.
	 *
	 * `skipped` filters on `skip_reason`, which is a *policy* skip; a page that was
	 * fetched and failed is `ok: false` with no skip reason. Pagination defaults to 100
	 * and is capped at 1000.
	 */
	listPages(
		uid: string,
		opts?: {
			ok?: boolean;
			status?: number | number[];
			notModified?: boolean;
			skipped?: boolean;
			limit?: number;
			offset?: number;
		},
	): Promise<PageRow[]> {
		return query.listPages(this.#ctx, uid, opts);
	}

	/**
	 * Sugar for {@linkcode CrawlerPg.listPages} with `ok: false, skipped: false` — the
	 * pages that were actually attempted and did not work out (transport errors and bad
	 * statuses), never the ones policy declined to fetch.
	 */
	listFailed(
		uid: string,
		opts?: { limit?: number; offset?: number },
	): Promise<PageRow[]> {
		return query.listFailed(this.#ctx, uid, opts);
	}

	/** The link graph of one crawl, in discovery order — followed edges and skipped ones. */
	listLinks(
		uid: string,
		opts?: {
			kind?: "internal" | "external";
			rel?: string;
			followed?: boolean;
			skipReason?: string;
			toUrl?: string;
			limit?: number;
			offset?: number;
		},
	): Promise<LinkRow[]> {
		return query.listLinks(this.#ctx, uid, opts);
	}

	/**
	 * Dead targets of this run, each with the pages that link to it, worst first.
	 *
	 * Only targets that were **visited in this same run** can appear, so what the crawl
	 * covered decides what this can report: `assets: true` to see broken images and
	 * stylesheets, `checkExternal: true` to see dead outbound links.
	 */
	brokenLinks(uid: string): Promise<BrokenLink[]> {
		return query.brokenLinks(this.#ctx, uid);
	}

	/**
	 * The archived bytes of one URL, or `null` when nothing is stored for it.
	 *
	 * The lookup is an exact match against the **normalized** URL, which this method
	 * cannot reproduce from a raw input — normalization is per-crawl and its options are
	 * not known here. Pass the `url` field of a `PageRow` or a `PageResult`.
	 */
	getBody(url: string): Promise<ArchivedBody | null> {
		return query.getBody(this.#ctx, url);
	}

	/**
	 * What this run saw that the previous one did not, by comparing per-run content
	 * hashes. `against` names the baseline run's `uid`; the default is this tenant's
	 * latest earlier `completed` crawl, and with no such run every URL reads as `"new"`.
	 *
	 * `"removed"` means "not in this run" — a narrowed scope, a lowered `maxDepth` or a
	 * budget that stopped the crawl early produce it just as a deleted page does.
	 */
	listChanged(uid: string, opts?: { against?: string }): Promise<ChangedUrl[]> {
		return query.listChanged(this.#ctx, uid, opts);
	}

	/**
	 * Deletes one crawl and, by cascade, its pages, links and frontier rows. The URL
	 * archive is untouched: it is keyed per tenant, not per crawl, and outlives every run
	 * — {@linkcode CrawlerPg.pruneUrls} is what shrinks it.
	 */
	deleteCrawl(uid: string): Promise<boolean> {
		return query.deleteCrawl(this.#ctx, uid);
	}

	/**
	 * Rebuilds a crawl's counters from its persisted page, link and frontier rows and
	 * force-writes them into the `stats` column, past any live throttle.
	 *
	 * Job mode calls this at the start of a resumed attempt, so that `onProgress` deltas
	 * count on from what is actually stored instead of from the snapshot the crashed
	 * attempt happened to leave behind. Two fields the engine keeps in memory cannot be
	 * rebuilt and are absent: `byHost` and `eta`. `skipped`/`skippedByReason` come from
	 * the persisted edges, so a skip with no source page — a rejected seed, a sitemap URL
	 * — is not counted.
	 */
	recomputeStats(uid: string): Promise<CrawlStats> {
		return query.recomputeStats(this.#ctx, uid);
	}

	/**
	 * Deletes archived URLs, returning how many. **This is the only method in the package
	 * that destroys data**, so it refuses a call with no filter; pass `olderThan` (a
	 * `Date` or epoch ms, compared against `fetched_at`), a `host`, or both.
	 *
	 * A pruned body makes the next re-crawl of that URL unconditional: conditional
	 * headers are only sent where a body is stored, so the page comes back in full and
	 * costs the bandwidth once more.
	 */
	pruneUrls(filter: { olderThan?: Date | number; host?: string }): Promise<number> {
		return query.pruneUrls(this.#ctx, filter);
	}

	/** Drops and recreates every table. Destroys all data — this is a test convenience. */
	async resetHard(): Promise<void> {
		await this.#initOnce(true);
	}

	/** Drops every table. Destroys all data. */
	async uninstall(): Promise<void> {
		await _uninstall({ db: this.#db, tableNames: this.#tableNames });
		this.#initialized = false;
		this.#init = null;
	}

	/** The raw DDL, for reviewing or installing the schema out of band. */
	static __schema(tablePrefix?: string): { drop: string; create: string } {
		const tableNames = _tableNames(tablePrefix ?? "");
		return {
			drop: _schemaDrop({ tableNames }),
			create: _schemaCreate({ tableNames }),
		};
	}
}

/** Factory alias for {@linkcode CrawlerPg}, so the package reads like its siblings. */
export function createCrawlerPg(options: CrawlerPgOptions): CrawlerPg {
	return new CrawlerPg(options);
}
