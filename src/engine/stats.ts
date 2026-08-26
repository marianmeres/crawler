/**
 * Internal — the crawl's counters, the {@linkcode "../types.ts".CrawlStats} snapshots
 * built from them, and {@linkcode safeEmit}, the wrapper every event call site goes
 * through.
 *
 * Everything here is a plain number or a `Map`, and every snapshot is JSON-serializable
 * by construction (no `Headers`, no functions, no class instances) — the job and
 * persistence layers write these straight into a JSONB column, and
 * {@linkcode "../types.ts".Crawler.stats} is documented as cheap enough to call in a
 * loop.
 *
 * `queued` and `inFlight` are *not* kept here: they are dispatcher state, passed into
 * {@linkcode StatsCounter.snapshot}. Asking the frontier for its size would make
 * `stats()` async, and the engine already knows both numbers exactly.
 *
 * @module
 */

import type { CrawlStats, Logger, SkipReason } from "../types.ts";

/**
 * Run one event handler and swallow whatever it does.
 *
 * This is the whole of the hook/event split. **Events observe**: a handler that throws
 * is caught, logged at `warn` and forgotten, so no observer can change a crawl's
 * outcome. **Hooks produce data** — `onPage`, `beforeExtract`, `shouldVisit`, `onLink`
 * and `priority` are deliberately *not* routed through here, because a throw there has
 * to be visible (it fails the page, or falls back).
 *
 * The return value is ignored and an async handler is **not awaited** — the crawl does
 * not wait for an observer, and an event's ordering guarantee is when it fires, not when
 * it finishes. A rejected promise is still caught, though: an unhandled rejection takes
 * the process down, which is precisely what "an event never affects the crawl" forbids.
 */
export function safeEmit(name: string, fn: () => unknown, logger?: Logger): void {
	try {
		const out = fn();
		if (out instanceof Promise) out.catch((e) => warn(name, e, logger));
	} catch (e) {
		warn(name, e, logger);
	}
}

function warn(name: string, e: unknown, logger?: Logger): void {
	logger?.warn(`[crawl] event handler ${name} threw:`, e);
}

/**
 * How many hosts a snapshot's `byHost` may name.
 *
 * The counter itself tracks every host it sees (one small entry each); the cap applies
 * to the *snapshot*, which is the thing that gets serialized, emitted on a timer and
 * written to a database row.
 */
export const BY_HOST_SNAPSHOT_LIMIT = 100;

/** Mutable counters for one run. Created by {@linkcode createStatsCounter}. */
export interface StatsCounter {
	/** Epoch ms the run started. */
	readonly startedAt: number;
	/** Completed fetches that succeeded. */
	readonly done: number;
	/** Completed fetches that failed terminally. */
	readonly failed: number;
	/** Links rejected before ever becoming work. */
	readonly skipped: number;
	/** Cumulative response bytes — what `maxTotalBytes` watches. */
	readonly bytes: number;
	/** Record one completed fetch. */
	recordPage(info: { ok: boolean; status: number; host: string; size?: number }): void;
	/** Record one rejected link. */
	recordSkip(reason: SkipReason): void;
	/** A full, JSON-serializable snapshot. */
	snapshot(live: { queued: number; inFlight: number }): CrawlStats;
}

/**
 * Fresh counters for one crawl.
 *
 * @param crawlId Stamped on every snapshot.
 * @param opts.maxPages The resolved page budget — the only thing that makes an `eta`
 * meaningful, so a snapshot carries one exactly when this is finite.
 * @param opts.now Clock override, injected by tests.
 */
export function createStatsCounter(
	crawlId: string,
	opts: { maxPages?: number; now?: () => number } = {},
): StatsCounter {
	const now = opts.now ?? Date.now;
	const maxPages = opts.maxPages ?? Infinity;
	const startedAt = now();

	const byStatus = new Map<number, number>();
	const byHost = new Map<string, number>();
	const skippedByReason = new Map<SkipReason, number>();

	let done = 0;
	let failed = 0;
	let skipped = 0;
	let bytes = 0;

	const bump = <K>(map: Map<K, number>, key: K): void => {
		map.set(key, (map.get(key) ?? 0) + 1);
	};

	return {
		get startedAt() {
			return startedAt;
		},
		get done() {
			return done;
		},
		get failed() {
			return failed;
		},
		get skipped() {
			return skipped;
		},
		get bytes() {
			return bytes;
		},

		recordPage(info): void {
			if (info.ok) done++;
			else failed++;
			// a terminal transport error has no status; `0` would be a lie in a
			// histogram of HTTP statuses, so it simply does not appear in one
			if (info.status > 0) bump(byStatus, info.status);
			if (info.host !== "") bump(byHost, info.host);
			if (typeof info.size === "number" && Number.isFinite(info.size)) {
				bytes += info.size;
			}
		},

		recordSkip(reason): void {
			skipped++;
			bump(skippedByReason, reason);
		},

		snapshot(live): CrawlStats {
			const elapsed = Math.max(0, now() - startedAt);
			const completed = done + failed;
			const pagesPerSecond = elapsed > 0 ? (completed * 1000) / elapsed : 0;

			const stats: CrawlStats = {
				crawlId,
				queued: live.queued,
				inFlight: live.inFlight,
				done,
				failed,
				skipped,
				bytes,
				startedAt,
				elapsed,
				pagesPerSecond,
				byStatus: Object.fromEntries(byStatus),
				skippedByReason: Object.fromEntries(skippedByReason),
			};

			if (byHost.size > 0) stats.byHost = topHosts(byHost);
			if (maxPages !== Infinity && pagesPerSecond > 0 && completed < maxPages) {
				stats.eta = ((maxPages - completed) / pagesPerSecond) * 1000;
			}

			return stats;
		},
	};
}

/** The busiest {@linkcode BY_HOST_SNAPSHOT_LIMIT} hosts, most pages first. */
function topHosts(byHost: Map<string, number>): Record<string, number> {
	if (byHost.size <= BY_HOST_SNAPSHOT_LIMIT) return Object.fromEntries(byHost);
	return Object.fromEntries(
		[...byHost].sort((a, b) => b[1] - a[1]).slice(0, BY_HOST_SNAPSHOT_LIMIT),
	);
}
