/**
 * `persistPage` — everything one completed page writes, in one transaction.
 *
 * Four statements, and the reason they share a transaction is the crash window: an ack
 * committed without its result would lose the page permanently, and a result committed
 * without its ack would re-fetch it forever. Together they are also **idempotent** —
 * upserts keyed on `(tenant_id, url)` and `(crawl_id, url)`, links replaced rather than
 * appended — which is what makes a retried job (or an `openCrawl` in-flight recovery)
 * safe to replay over rows that are already there.
 *
 * The one column with real logic behind it is `__crawler_url.body`: the archive holds the
 * *last good* body next to the *last observed* status and validators, so a 304, a 500 and
 * a `persistBody: false` all leave the stored bytes alone. Note the second half of that
 * CASE — "the hash did not change" only keeps the stored bytes when there *are* stored
 * bytes. `VisitedStore.add` records the same hash from the engine, and events are not
 * awaited, so it regularly gets there first; without the `body IS NOT NULL` guard the
 * body would look unchanged against a row that never had one and would never be written.
 *
 * @module
 */

import { Buffer } from "node:buffer";
import type { FetchResult, Logger, PageResult } from "../types.ts";
import { maskUserinfo } from "../url/_mask-userinfo.ts";
import type { CrawlerContext } from "./crawler-pg.ts";

/** `true` when an HTTP response was observed at all — a transport error reports `0`. */
function hasResponse(res: PageResult): boolean {
	return typeof res.status === "number" && res.status > 0;
}

/**
 * The bytes to archive, or `null` to keep whatever is stored.
 *
 * Three ways to get `null`: the response was not ok (an error page must not overwrite the
 * good copy), no body was retained, or {@linkcode CrawlerPgOptions.persistBody} said no.
 */
async function bodyOf(
	ctx: CrawlerContext,
	res: PageResult,
	fetchResult?: FetchResult,
): Promise<Buffer | null> {
	if (!res.ok || !fetchResult?.hasBody) return null;
	const wanted = typeof ctx.persistBody === "function"
		? ctx.persistBody(res)
		: ctx.persistBody;
	if (!wanted) return null;
	return Buffer.from(await fetchResult.bytes());
}

/**
 * `onPage`'s return value, pre-flighted through the serializer node-postgres would use
 * anyway. A `BigInt` throws there and a throw inside the transaction would cost the whole
 * page — so it is caught here, once, and the page is written with `data = NULL`.
 */
function dataOf(res: PageResult, logger?: Logger): string | null {
	if (res.data === undefined) return null;
	try {
		// `undefined` back from a successful stringify means the value had no JSON
		// representation at all (a function, a bare `undefined`) — also NULL
		return JSON.stringify(res.data) ?? null;
	} catch (e) {
		logger?.warn(
			`persistPage: onPage data for ${maskUserinfo(res.url)} is not ` +
				`JSON-serializable, storing NULL (${e instanceof Error ? e.message : e})`,
		);
		return null;
	}
}

/**
 * Writes one completed page: the URL archive upsert, the page-row upsert, this page's
 * outgoing edges, and the frontier ack — atomically.
 *
 * @internal
 */
export async function persistPage(
	ctx: CrawlerContext,
	crawlId: number,
	res: PageResult,
	fetchResult?: FetchResult,
): Promise<void> {
	await ctx.ready();
	const { tableUrl, tablePage, tableLink, tableFrontier } = ctx.tableNames;

	// outside the transaction: reading the retained buffer and serializing `data` are
	// both things that can take a moment, and neither needs to hold a connection
	const body = await bodyOf(ctx, res, fetchResult);
	const data = dataOf(res, ctx.logger);
	const links = res.links ?? [];

	await ctx.transaction(async (client) => {
		let urlId: number | null = null;
		if (hasResponse(res)) {
			const { rows } = await client.query(
				`INSERT INTO ${tableUrl}
					(tenant_id, url, body, content_type, charset, etag, last_modified,
						content_hash, last_status, size, fetched_at)
					VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
					ON CONFLICT (tenant_id, url) DO UPDATE SET
						body = CASE
							WHEN EXCLUDED.body IS NULL THEN ${tableUrl}.body
							WHEN ${tableUrl}.body IS NOT NULL
								AND ${tableUrl}.content_hash
									IS NOT DISTINCT FROM EXCLUDED.content_hash
							THEN ${tableUrl}.body ELSE EXCLUDED.body END,
						content_type  = COALESCE(EXCLUDED.content_type, ${tableUrl}.content_type),
						charset       = COALESCE(EXCLUDED.charset, ${tableUrl}.charset),
						etag          = COALESCE(EXCLUDED.etag, ${tableUrl}.etag),
						last_modified = COALESCE(EXCLUDED.last_modified, ${tableUrl}.last_modified),
						content_hash  = COALESCE(EXCLUDED.content_hash, ${tableUrl}.content_hash),
						last_status   = EXCLUDED.last_status,
						size          = COALESCE(EXCLUDED.size, ${tableUrl}.size),
						fetched_at    = NOW()
					RETURNING id`,
				[
					ctx.tenantId,
					res.url,
					body,
					res.contentType ?? null,
					res.charset ?? null,
					fetchResult?.headers.get("etag") ?? null,
					fetchResult?.headers.get("last-modified") ?? null,
					res.contentHash ?? null,
					res.status,
					res.size ?? null,
				],
			);
			urlId = rows[0].id;
		}

		await client.query(
			`INSERT INTO ${tablePage}
				(tenant_id, crawl_id, url_id, url, final_url, depth, discovered_via,
					referrer, status, ok, not_modified, content_type, content_hash, title,
					size, attempts, timing, error_kind, error_message, data, fetched_at)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
					$16, $17::jsonb, $18, $19, $20::jsonb, NOW())
				ON CONFLICT (crawl_id, url) DO UPDATE SET
					url_id = EXCLUDED.url_id,
					final_url = EXCLUDED.final_url,
					depth = EXCLUDED.depth,
					discovered_via = EXCLUDED.discovered_via,
					referrer = EXCLUDED.referrer,
					status = EXCLUDED.status,
					ok = EXCLUDED.ok,
					not_modified = EXCLUDED.not_modified,
					content_type = EXCLUDED.content_type,
					content_hash = EXCLUDED.content_hash,
					title = EXCLUDED.title,
					size = EXCLUDED.size,
					attempts = EXCLUDED.attempts,
					timing = EXCLUDED.timing,
					error_kind = EXCLUDED.error_kind,
					error_message = EXCLUDED.error_message,
					data = EXCLUDED.data,
					fetched_at = NOW()`,
			[
				ctx.tenantId,
				crawlId,
				urlId,
				res.url,
				res.finalUrl ?? null,
				res.depth,
				res.discoveredVia,
				res.referrer ?? null,
				hasResponse(res) ? res.status : null,
				res.ok,
				res.notModified,
				res.contentType ?? null,
				res.contentHash ?? null,
				res.title ?? null,
				res.size ?? null,
				res.attempts,
				JSON.stringify(res.timing ?? {}),
				res.error?.kind ?? null,
				res.error?.message ?? null,
				data,
			],
		);

		// delete-then-insert, because a page may legitimately carry the same edge twice
		// (two anchors, one target) and no unique key can tell that from a replay
		await client.query(
			`DELETE FROM ${tableLink} WHERE crawl_id = $1 AND from_url = $2`,
			[crawlId, res.url],
		);
		if (links.length) {
			await client.query(
				`INSERT INTO ${tableLink}
					(tenant_id, crawl_id, from_url, to_url, raw_href, kind, rel, nofollow,
						anchor_text, followed, skip_reason)
					SELECT $1, $2, $3, l.to_url, l.raw_href, l.kind, l.rel, l.nofollow,
						l.anchor_text, l.followed, l.skip_reason
					FROM UNNEST($4::text[], $5::text[], $6::text[], $7::text[],
							$8::boolean[], $9::text[], $10::boolean[], $11::text[])
						AS l(to_url, raw_href, kind, rel, nofollow, anchor_text, followed,
							skip_reason)`,
				[
					ctx.tenantId,
					crawlId,
					// the edges of *this* page, so the DELETE above always covers what the
					// INSERT writes — whatever a `LinkRecord.from` says
					res.url,
					links.map((l) => l.to),
					links.map((l) => l.rawHref ?? null),
					links.map((l) => l.kind),
					links.map((l) => l.rel),
					links.map((l) => l.nofollow),
					links.map((l) => l.anchorText ?? null),
					links.map((l) => l.followed),
					links.map((l) => l.skipReason ?? null),
				],
			);
		}

		await client.query(
			`UPDATE ${tableFrontier} SET status = 'done'
				WHERE crawl_id = $1 AND url = $2`,
			[crawlId, res.url],
		);
	});
}
