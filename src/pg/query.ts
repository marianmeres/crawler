/**
 * The read side of `./pg`: the questions a consumer asks after (or during) a crawl —
 * what ran, what failed, what is broken, what changed, give me the body — as methods
 * instead of hand-written SQL.
 *
 * Three properties hold for everything in here:
 *
 * 1. **Every statement is tenant-scoped**, and a crawl is addressed by its `uid`, never
 *    by the internal serial id. The id → uid indirection is a sub-select, so a crawl that
 *    does not exist reads as an empty result rather than as another round trip.
 * 2. **Lists paginate**: `limit` defaults to 100 and is capped at 1000, `ORDER BY id` —
 *    i.e. insertion order, which for pages and links is discovery order.
 * 3. **Reads never install the schema on their own account** — they `await ctx.ready()`
 *    like every other public DB method, so querying a fresh instance cannot fail on a
 *    missing table.
 *
 * @module
 */

import type { CrawlStats, DiscoveredVia, LinkRel, SkipReason } from "../types.ts";
// type-only, so `crawler-pg.ts` can import the functions below as values without a
// runtime cycle — the same arrangement as `stores.ts` and `persist.ts`
import type { CrawlerContext, CrawlRow, CrawlStatus } from "./crawler-pg.ts";

/** One `__crawler_page` row, camelCased. One per URL per crawl. */
export interface PageRow {
	id: number;
	tenantId: string;
	crawlId: number;
	/** The archive row this page's bytes went to; `null` when nothing was archived. */
	urlId: number | null;
	url: string;
	finalUrl: string | null;
	depth: number;
	discoveredVia: DiscoveredVia;
	referrer: string | null;
	/** `null` when the fetch failed before a response — see `errorKind`. */
	status: number | null;
	ok: boolean;
	notModified: boolean;
	contentType: string | null;
	contentHash: string | null;
	title: string | null;
	size: number | null;
	attempts: number;
	timing: Record<string, number>;
	errorKind: string | null;
	errorMessage: string | null;
	skipReason: string | null;
	/** Whatever `onPage` returned, round-tripped through JSONB. */
	data: unknown;
	fetchedAt: Date;
}

/** One `__crawler_link` row, camelCased. One per extracted edge, followed or not. */
export interface LinkRow {
	id: number;
	tenantId: string;
	crawlId: number;
	fromUrl: string;
	toUrl: string;
	rawHref: string | null;
	kind: "internal" | "external";
	rel: LinkRel;
	nofollow: boolean;
	anchorText: string | null;
	followed: boolean;
	skipReason: SkipReason | null;
	createdAt: Date;
}

/** A dead target and every page that links to it. */
export interface BrokenLink {
	toUrl: string;
	/** `null` when the fetch never got a response. */
	status: number | null;
	errorKind?: string;
	fromUrls: string[];
}

/** One URL's verdict when diffing two runs. */
export interface ChangedUrl {
	url: string;
	change: "new" | "changed" | "removed";
	/** Absent on `"removed"`. */
	contentHash?: string;
	/** Absent on `"new"`. */
	previousHash?: string;
}

/** What the archive remembers about one URL for the purpose of re-fetching it. */
export interface UrlValidators {
	/** `If-None-Match` on the next fetch. */
	etag?: string;
	/** `If-Modified-Since` on the next fetch. */
	lastModified?: string;
	/** SHA-256 hex of the last archived bytes. */
	contentHash?: string;
	/**
	 * Whether the archive holds this URL's body — and therefore whether a `304` would be
	 * useful. Without it there is nothing to re-extract links from, so the validators
	 * above must not be sent.
	 */
	hasBody: boolean;
}

/** The archived bytes of one URL, with the metadata needed to decode them. */
export interface ArchivedBody {
	body: Uint8Array;
	contentType?: string;
	charset?: string;
	contentHash?: string;
	etag?: string;
	lastModified?: string;
	fetchedAt: Date;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

function paging(
	opts?: { limit?: number; offset?: number },
): [limit: number, offset: number] {
	return [
		Math.max(0, Math.min(opts?.limit ?? DEFAULT_LIMIT, MAX_LIMIT)),
		Math.max(0, opts?.offset ?? 0),
	];
}

/** Builds `$n` placeholders against a growing values array. */
function binder(values: unknown[]) {
	return (value: unknown): string => `$${values.push(value)}`;
}

/** @internal */
// deno-lint-ignore no-explicit-any -- a pg result row is untyped by construction
export function _toCrawlRow(row: any): CrawlRow {
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

// deno-lint-ignore no-explicit-any -- a pg result row is untyped by construction
function toPageRow(row: any): PageRow {
	return {
		id: row.id,
		tenantId: row.tenant_id,
		crawlId: row.crawl_id,
		urlId: row.url_id,
		url: row.url,
		finalUrl: row.final_url,
		depth: row.depth,
		discoveredVia: row.discovered_via,
		referrer: row.referrer,
		status: row.status,
		ok: row.ok,
		notModified: row.not_modified,
		contentType: row.content_type,
		contentHash: row.content_hash,
		title: row.title,
		size: row.size,
		attempts: row.attempts,
		timing: row.timing ?? {},
		errorKind: row.error_kind,
		errorMessage: row.error_message,
		skipReason: row.skip_reason,
		data: row.data ?? undefined,
		fetchedAt: row.fetched_at,
	};
}

// deno-lint-ignore no-explicit-any -- a pg result row is untyped by construction
function toLinkRow(row: any): LinkRow {
	return {
		id: row.id,
		tenantId: row.tenant_id,
		crawlId: row.crawl_id,
		fromUrl: row.from_url,
		toUrl: row.to_url,
		rawHref: row.raw_href,
		kind: row.kind,
		rel: row.rel,
		nofollow: row.nofollow,
		anchorText: row.anchor_text,
		followed: row.followed,
		skipReason: row.skip_reason,
		createdAt: row.created_at,
	};
}

/** The `crawl_id = (…)` sub-select every per-crawl read starts from. @internal */
function crawlIdSubselect(
	ctx: CrawlerContext,
	bind: (v: unknown) => string,
	uid: string,
) {
	return `(SELECT id FROM ${ctx.tableNames.tableCrawl}
		WHERE tenant_id = ${bind(ctx.tenantId)} AND uid = ${bind(uid)})`;
}

/** @internal */
export async function getCrawl(
	ctx: CrawlerContext,
	uid: string,
): Promise<CrawlRow | null> {
	await ctx.ready();
	const { rows } = await ctx.db.query(
		`SELECT * FROM ${ctx.tableNames.tableCrawl} WHERE tenant_id = $1 AND uid = $2`,
		[ctx.tenantId, uid],
	);
	return rows.length ? _toCrawlRow(rows[0]) : null;
}

/** @internal */
export async function getCrawlByJobUid(
	ctx: CrawlerContext,
	jobUid: string,
): Promise<CrawlRow | null> {
	await ctx.ready();
	const { rows } = await ctx.db.query(
		`SELECT * FROM ${ctx.tableNames.tableCrawl}
			WHERE tenant_id = $1 AND job_uid = $2
			ORDER BY id DESC LIMIT 1`,
		[ctx.tenantId, jobUid],
	);
	return rows.length ? _toCrawlRow(rows[0]) : null;
}

/** @internal */
export async function listCrawls(
	ctx: CrawlerContext,
	opts: { status?: CrawlStatus; limit?: number; offset?: number } = {},
): Promise<CrawlRow[]> {
	await ctx.ready();
	const values: unknown[] = [];
	const bind = binder(values);
	const where = [`tenant_id = ${bind(ctx.tenantId)}`];
	if (opts.status !== undefined) where.push(`status = ${bind(opts.status)}`);
	const [limit, offset] = paging(opts);
	const { rows } = await ctx.db.query(
		`SELECT * FROM ${ctx.tableNames.tableCrawl}
			WHERE ${where.join(" AND ")}
			ORDER BY created_at DESC, id DESC
			LIMIT ${bind(limit)} OFFSET ${bind(offset)}`,
		values,
	);
	return rows.map(_toCrawlRow);
}

/** @internal */
export async function crawlStats(
	ctx: CrawlerContext,
	uid: string,
): Promise<Partial<CrawlStats> | null> {
	await ctx.ready();
	const { rows } = await ctx.db.query(
		`SELECT stats FROM ${ctx.tableNames.tableCrawl} WHERE tenant_id = $1 AND uid = $2`,
		[ctx.tenantId, uid],
	);
	return rows.length ? rows[0].stats ?? {} : null;
}

/** @internal */
export async function listPages(
	ctx: CrawlerContext,
	uid: string,
	opts: {
		ok?: boolean;
		status?: number | number[];
		notModified?: boolean;
		skipped?: boolean;
		limit?: number;
		offset?: number;
	} = {},
): Promise<PageRow[]> {
	await ctx.ready();
	const values: unknown[] = [];
	const bind = binder(values);
	const where = [`crawl_id = ${crawlIdSubselect(ctx, bind, uid)}`];
	if (opts.ok !== undefined) where.push(`ok = ${bind(opts.ok)}`);
	if (opts.notModified !== undefined) {
		where.push(`not_modified = ${bind(opts.notModified)}`);
	}
	if (opts.skipped !== undefined) {
		where.push(`skip_reason IS ${opts.skipped ? "NOT NULL" : "NULL"}`);
	}
	if (opts.status !== undefined) {
		const list = Array.isArray(opts.status) ? opts.status : [opts.status];
		where.push(`status = ANY(${bind(list)}::int[])`);
	}
	const [limit, offset] = paging(opts);
	const { rows } = await ctx.db.query(
		`SELECT * FROM ${ctx.tableNames.tablePage}
			WHERE ${where.join(" AND ")}
			ORDER BY id
			LIMIT ${bind(limit)} OFFSET ${bind(offset)}`,
		values,
	);
	return rows.map(toPageRow);
}

/** @internal */
export function listFailed(
	ctx: CrawlerContext,
	uid: string,
	opts: { limit?: number; offset?: number } = {},
): Promise<PageRow[]> {
	return listPages(ctx, uid, { ...opts, ok: false, skipped: false });
}

/** @internal */
export async function listLinks(
	ctx: CrawlerContext,
	uid: string,
	opts: {
		kind?: "internal" | "external";
		rel?: string;
		followed?: boolean;
		skipReason?: string;
		toUrl?: string;
		limit?: number;
		offset?: number;
	} = {},
): Promise<LinkRow[]> {
	await ctx.ready();
	const values: unknown[] = [];
	const bind = binder(values);
	const where = [`crawl_id = ${crawlIdSubselect(ctx, bind, uid)}`];
	if (opts.kind !== undefined) where.push(`kind = ${bind(opts.kind)}`);
	if (opts.rel !== undefined) where.push(`rel = ${bind(opts.rel)}`);
	if (opts.followed !== undefined) where.push(`followed = ${bind(opts.followed)}`);
	if (opts.skipReason !== undefined) {
		where.push(`skip_reason = ${bind(opts.skipReason)}`);
	}
	if (opts.toUrl !== undefined) where.push(`to_url = ${bind(opts.toUrl)}`);
	const [limit, offset] = paging(opts);
	const { rows } = await ctx.db.query(
		`SELECT * FROM ${ctx.tableNames.tableLink}
			WHERE ${where.join(" AND ")}
			ORDER BY id
			LIMIT ${bind(limit)} OFFSET ${bind(offset)}`,
		values,
	);
	return rows.map(toLinkRow);
}

/** @internal */
export async function brokenLinks(
	ctx: CrawlerContext,
	uid: string,
): Promise<BrokenLink[]> {
	await ctx.ready();
	const values: unknown[] = [];
	const bind = binder(values);
	const crawlId = crawlIdSubselect(ctx, bind, uid);
	const { rows } = await ctx.db.query(
		`SELECT l.to_url, p.status, p.error_kind,
				array_agg(DISTINCT l.from_url ORDER BY l.from_url) AS from_urls
			FROM ${ctx.tableNames.tableLink} l
			JOIN ${ctx.tableNames.tablePage} p
				ON p.crawl_id = l.crawl_id AND p.url = l.to_url
			WHERE l.crawl_id = ${crawlId} AND NOT p.ok AND p.skip_reason IS NULL
			GROUP BY l.to_url, p.status, p.error_kind
			ORDER BY count(*) DESC, l.to_url`,
		values,
	);
	// deno-lint-ignore no-explicit-any -- a pg result row is untyped by construction
	return rows.map((row: any) => {
		const broken: BrokenLink = {
			toUrl: row.to_url,
			status: row.status,
			fromUrls: row.from_urls,
		};
		if (row.error_kind !== null) broken.errorKind = row.error_kind;
		return broken;
	});
}

/** @internal */
export async function getValidators(
	ctx: CrawlerContext,
	url: string,
): Promise<UrlValidators | null> {
	await ctx.ready();
	const { rows } = await ctx.db.query(
		`SELECT etag, last_modified, content_hash, (body IS NOT NULL) AS has_body
			FROM ${ctx.tableNames.tableUrl}
			WHERE tenant_id = $1 AND url = $2`,
		[ctx.tenantId, url],
	);
	const row = rows[0];
	if (!row) return null;

	const validators: UrlValidators = { hasBody: row.has_body === true };
	if (row.etag !== null) validators.etag = row.etag;
	if (row.last_modified !== null) validators.lastModified = row.last_modified;
	if (row.content_hash !== null) validators.contentHash = row.content_hash;
	return validators;
}

/** @internal */
export async function getBody(
	ctx: CrawlerContext,
	url: string,
): Promise<ArchivedBody | null> {
	await ctx.ready();
	const { rows } = await ctx.db.query(
		`SELECT body, content_type, charset, content_hash, etag, last_modified, fetched_at
			FROM ${ctx.tableNames.tableUrl}
			WHERE tenant_id = $1 AND url = $2`,
		[ctx.tenantId, url],
	);
	const row = rows[0];
	if (!row?.body) return null;

	const archived: ArchivedBody = {
		body: new Uint8Array(row.body),
		fetchedAt: row.fetched_at,
	};
	if (row.content_type !== null) archived.contentType = row.content_type;
	if (row.charset !== null) archived.charset = row.charset;
	if (row.content_hash !== null) archived.contentHash = row.content_hash;
	if (row.etag !== null) archived.etag = row.etag;
	if (row.last_modified !== null) archived.lastModified = row.last_modified;
	return archived;
}

/** @internal */
export async function listChanged(
	ctx: CrawlerContext,
	uid: string,
	opts: { against?: string } = {},
): Promise<ChangedUrl[]> {
	await ctx.ready();
	const { tableCrawl, tablePage } = ctx.tableNames;

	const current = await getCrawl(ctx, uid);
	if (!current) return [];

	let againstId: number | null = null;
	if (opts.against !== undefined) {
		const previous = await getCrawl(ctx, opts.against);
		if (!previous) {
			throw new Error(
				`Crawl '${opts.against}' not found (tenant '${ctx.tenantId}')`,
			);
		}
		againstId = previous.id;
	} else {
		// the latest *earlier* completed run; row-wise comparison so two runs created in
		// the same millisecond still order deterministically
		const { rows } = await ctx.db.query(
			`SELECT id FROM ${tableCrawl}
				WHERE tenant_id = $1 AND status = 'completed' AND (created_at, id) < ($2, $3)
				ORDER BY created_at DESC, id DESC
				LIMIT 1`,
			[ctx.tenantId, current.createdAt, current.id],
		);
		againstId = rows.length ? rows[0].id : null;
	}

	// a NULL baseline matches no row, so every URL of the current run reads as "new"
	const { rows } = await ctx.db.query(
		`WITH cur AS (SELECT url, content_hash FROM ${tablePage}
					WHERE crawl_id = $1 AND ok AND skip_reason IS NULL),
			prev AS (SELECT url, content_hash FROM ${tablePage}
					WHERE crawl_id = $2 AND ok AND skip_reason IS NULL)
			SELECT COALESCE(c.url, p.url) AS url,
				CASE WHEN p.url IS NULL THEN 'new'
					WHEN c.url IS NULL THEN 'removed'
					ELSE 'changed' END AS change,
				c.content_hash, p.content_hash AS previous_hash
			FROM cur c FULL OUTER JOIN prev p USING (url)
			WHERE p.url IS NULL OR c.url IS NULL
				OR c.content_hash IS DISTINCT FROM p.content_hash
			ORDER BY url`,
		[current.id, againstId],
	);

	// deno-lint-ignore no-explicit-any -- a pg result row is untyped by construction
	return rows.map((row: any) => {
		const changed: ChangedUrl = { url: row.url, change: row.change };
		if (row.content_hash !== null) changed.contentHash = row.content_hash;
		if (row.previous_hash !== null) changed.previousHash = row.previous_hash;
		return changed;
	});
}

/** @internal */
export async function deleteCrawl(ctx: CrawlerContext, uid: string): Promise<boolean> {
	await ctx.ready();
	const { rowCount } = await ctx.db.query(
		`DELETE FROM ${ctx.tableNames.tableCrawl} WHERE tenant_id = $1 AND uid = $2`,
		[ctx.tenantId, uid],
	);
	return (rowCount ?? 0) > 0;
}

/** @internal */
export async function recomputeStats(
	ctx: CrawlerContext,
	uid: string,
): Promise<CrawlStats> {
	await ctx.ready();
	const { tableCrawl, tablePage, tableLink, tableFrontier } = ctx.tableNames;

	const { rows } = await ctx.db.query(
		`SELECT c.id, c.uid, c.started_at, c.created_at, c.ended_at,
				(SELECT count(*)::int FROM ${tableFrontier}
					WHERE crawl_id = c.id AND status = 'pending') AS queued,
				(SELECT count(*)::int FROM ${tableFrontier}
					WHERE crawl_id = c.id AND status = 'in_flight') AS in_flight,
				(SELECT count(*)::int FROM ${tablePage}
					WHERE crawl_id = c.id AND ok AND skip_reason IS NULL) AS done,
				(SELECT count(*)::int FROM ${tablePage}
					WHERE crawl_id = c.id AND NOT ok AND skip_reason IS NULL) AS failed,
				(SELECT COALESCE(sum(size), 0)::bigint FROM ${tablePage}
					WHERE crawl_id = c.id) AS bytes,
				(SELECT count(*)::int FROM ${tableLink}
					WHERE crawl_id = c.id AND skip_reason IS NOT NULL) AS skipped,
				(SELECT COALESCE(jsonb_object_agg(status, n), '{}'::jsonb) FROM (
					SELECT status::text AS status, count(*)::int AS n FROM ${tablePage}
					WHERE crawl_id = c.id AND status IS NOT NULL AND status > 0
					GROUP BY status) s) AS by_status,
				(SELECT COALESCE(jsonb_object_agg(skip_reason, n), '{}'::jsonb) FROM (
					SELECT skip_reason, count(*)::int AS n FROM ${tableLink}
					WHERE crawl_id = c.id AND skip_reason IS NOT NULL
					GROUP BY skip_reason) r) AS skipped_by_reason
			FROM ${tableCrawl} c
			WHERE c.tenant_id = $1 AND c.uid = $2`,
		[ctx.tenantId, uid],
	);
	if (!rows.length) {
		throw new Error(`Crawl '${uid}' not found (tenant '${ctx.tenantId}')`);
	}

	const row = rows[0];
	const startedAt = (row.started_at ?? row.created_at).getTime();
	const elapsed = Math.max(
		0,
		(row.ended_at ? (row.ended_at as Date).getTime() : Date.now()) - startedAt,
	);
	const completed = row.done + row.failed;
	const stats: CrawlStats = {
		crawlId: row.uid,
		queued: row.queued,
		inFlight: row.in_flight,
		done: row.done,
		failed: row.failed,
		skipped: row.skipped,
		// sum() is int8, which node-postgres hands over as a string
		bytes: Number(row.bytes),
		startedAt,
		elapsed,
		pagesPerSecond: elapsed > 0 ? (completed * 1000) / elapsed : 0,
		byStatus: row.by_status,
		skippedByReason: row.skipped_by_reason,
	};

	await ctx.db.query(
		`UPDATE ${tableCrawl} SET stats = $2::jsonb, updated_at = NOW() WHERE id = $1`,
		[row.id, JSON.stringify(stats)],
	);
	return stats;
}

/**
 * The host of a stored URL, as PostgreSQL sees it: scheme, optional userinfo, then the
 * host up to a port/path/query/fragment. `__crawler_url` keeps no host column — one more
 * index on a table whose only host query is this maintenance call.
 */
const URL_HOST =
	`substring(url from '^[a-zA-Z][a-zA-Z0-9+.-]*://(?:[^@/]*@)?([^:/?#]*)')`;

/** @internal */
export async function pruneUrls(
	ctx: CrawlerContext,
	filter: { olderThan?: Date | number; host?: string },
): Promise<number> {
	if (filter?.olderThan === undefined && !filter?.host) {
		throw new TypeError(
			"pruneUrls needs at least one filter (`olderThan` and/or `host`) — " +
				"deleting the whole archive is not something this method will do by omission",
		);
	}
	await ctx.ready();

	const values: unknown[] = [];
	const bind = binder(values);
	const where = [`tenant_id = ${bind(ctx.tenantId)}`];
	if (filter.olderThan !== undefined) {
		where.push(`fetched_at < ${bind(new Date(filter.olderThan))}`);
	}
	if (filter.host) {
		where.push(`lower(${URL_HOST}) = ${bind(filter.host.toLowerCase())}`);
	}

	const { rowCount } = await ctx.db.query(
		`DELETE FROM ${ctx.tableNames.tableUrl} WHERE ${where.join(" AND ")}`,
		values,
	);
	return rowCount ?? 0;
}
