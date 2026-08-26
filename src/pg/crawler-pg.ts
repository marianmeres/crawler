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
import type { CrawlStats, Logger, StoppedBy } from "../types.ts";
import type { FrontierStore, VisitedStore } from "../stores/types.ts";
import { PgFrontierStore, PgVisitedStore } from "./stores.ts";
import {
	_initialize,
	_schemaCreate,
	_schemaDrop,
	_tableNames,
	_uninstall,
	type CrawlerTableNames,
} from "./_schema.ts";
import { isPool, type Queryable } from "./utils/with-transaction.ts";

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
	 * `pending` (or a resumed `failed`/`stopped`) → `running`. The first call stamps
	 * `startedAt`; later ones keep it, so a resumed attempt reports the original start.
	 */
	markRunning(): Promise<void>;
	/** Terminal. `stats` is force-written when given, otherwise the last snapshot stands. */
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
	logger?: Logger;
	/** Resolves once the schema is installed; every DB method awaits it first. */
	ready(): Promise<void>;
}

class CrawlHandle implements CrawlPersistence {
	#ctx: CrawlerContext;
	#row: CrawlRow;
	readonly stores: { frontier: FrontierStore; visited: VisitedStore };

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
		this.#row = toCrawlRow(rows[0]);
	}

	async markEnded(end: {
		status: "completed" | "failed" | "stopped";
		stoppedBy?: StoppedBy;
		error?: string;
		stats?: CrawlStats;
	}): Promise<void> {
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
				end.stats ? JSON.stringify(end.stats) : null,
			],
		);
		this.#row = toCrawlRow(rows[0]);
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
			logger: this.#logger,
			ready: () => this.#initOnce(),
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
		return new CrawlHandle(this.#ctx, toCrawlRow(rows[0]));
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
		const row = toCrawlRow(rows[0]);
		await this.#query(
			`UPDATE ${this.#tableNames.tableFrontier}
				SET status = 'pending', claimed_at = NULL
				WHERE crawl_id = $1 AND status = 'in_flight'`,
			[row.id],
		);
		return new CrawlHandle(this.#ctx, row);
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

// deno-lint-ignore no-explicit-any -- a pg result row is untyped by construction
function toCrawlRow(row: any): CrawlRow {
	return {
		id: row.id,
		uid: row.uid,
		tenantId: row.tenant_id,
		seeds: row.seeds ?? [],
		options: row.options ?? {},
		status: row.status,
		stats: row.stats ?? {},
		stoppedBy: row.stopped_by,
		error: row.error,
		jobUid: row.job_uid,
		startedAt: row.started_at,
		endedAt: row.ended_at,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}
