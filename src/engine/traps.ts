/**
 * Internal — the caps behind {@linkcode "../types.ts".TrapOptions}: the pure URL-shape
 * checks and the per-run counters that catch an infinite URL space.
 *
 * Real sites contain URL spaces no crawl can finish: calendars that link to the next day
 * forever, faceted search whose filters combine without end, relative links that nest a
 * path into itself, and soft-404 farms that answer every URL with the same page. None of
 * them is detectable from a single URL alone, so this module has two halves:
 *
 * - {@linkcode detectUrlTrap} — pure, stateless, per URL: segment repeats, path depth,
 *   query-param count. Cheap enough to run on every follow-candidate.
 * - {@linkcode createTrapTracker} — the two counters that need to remember the run: how
 *   many distinct URLs one `(host, pathname)` has produced, and how many pages share one
 *   `contentHash`.
 *
 * **Memory shape** (asked about often enough to state up front): the tracker holds one
 * entry per distinct `(host, pathname)` actually seen, each carrying at most
 * `maxUrlsPerPath + 1` query strings, plus one entry per distinct `contentHash` actually
 * seen. Both maps are per-run and in memory *even when the stores are PostgreSQL* — trap
 * state is a property of this crawl's traversal, not of the archive. A distributed crawl
 * that needed shared trap state would make it a store concern; v1 does not.
 *
 * Every cap is disabled by `Infinity` and validated `> 0` by `resolveCrawlOptions`, so
 * nothing here has to defend against a zero.
 *
 * @module
 */

import type { Logger, TrapOptions } from "../types.ts";

/** The stateful half — one per run. See {@linkcode createTrapTracker}. */
export interface TrapTracker {
	/**
	 * Called once per follow-candidate that survived the cheaper checks.
	 *
	 * @returns `true` when this URL is one distinct URL too many for its
	 * `(host, pathname)` — the faceted-search / calendar signature.
	 */
	checkAndCount(url: URL): boolean;
	/**
	 * Called once per completed page that produced a `contentHash`.
	 *
	 * @param sampleUrl Only ever used to make the one-per-hash warning readable.
	 * @returns `true` when this hash is now *over* {@linkcode TrapOptions.softDupThreshold},
	 * i.e. the page it belongs to must not be expanded.
	 */
	countHash(contentHash: string, sampleUrl?: string): boolean;
	/** Hashes that crossed the threshold — surfaced in logs and available to recipes. */
	softDupHashes(): string[];
}

/**
 * Is this URL's *shape* a trap?
 *
 * Three independent caps, all first-hit-wins and all "at the cap is fine, one over is
 * not": `/a/b/a/b/a/b` passes a `maxSegmentRepeat` of 3 and `/a/b/a/b/a/b/a` does not.
 * The distinction matters — a legitimate deep documentation tree sits *at* a cap far more
 * often than a real trap sits one under it.
 *
 * `maxQueryParams` counts **distinct parameter names**: `?tag=a&tag=b&tag=c` is one
 * faceted parameter used three times, not three parameters, and a crawl that treated it
 * as three would reject the most ordinary multi-select filter there is.
 *
 * Pure, synchronous, never throws.
 *
 * @example
 * ```ts
 * const opts = resolveCrawlOptions({}).traps;
 * detectUrlTrap(new URL("https://a.com/a/b/a/b/a/b"), opts);   // => false (at the cap)
 * detectUrlTrap(new URL("https://a.com/a/b/a/b/a/b/a"), opts); // => true
 * ```
 */
export function detectUrlTrap(url: URL, opts: Required<TrapOptions>): boolean {
	const segments = url.pathname.split("/").filter((s) => s !== "");

	if (segments.length > opts.maxPathDepth) return true;

	if (opts.maxSegmentRepeat !== Infinity) {
		const seen = new Map<string, number>();
		for (const segment of segments) {
			const n = (seen.get(segment) ?? 0) + 1;
			if (n > opts.maxSegmentRepeat) return true;
			seen.set(segment, n);
		}
	}

	if (opts.maxQueryParams !== Infinity && url.search !== "") {
		const names = new Set<string>();
		for (const name of url.searchParams.keys()) {
			names.add(name);
			if (names.size > opts.maxQueryParams) return true;
		}
	}

	return false;
}

/**
 * The two counters that need to remember the whole run.
 *
 * @param logger Gets exactly one `warn` per `contentHash` that crosses
 * {@linkcode TrapOptions.softDupThreshold} — a soft-404 farm is otherwise invisible: the
 * pages all answer `200`, and only the count of identical bodies gives it away.
 */
export function createTrapTracker(
	opts: Required<TrapOptions>,
	logger?: Logger,
): TrapTracker {
	// `(host + pathname)` → the query strings seen under it. The set stops growing one
	// past the cap: everything after that is a trap regardless, so there is nothing left
	// to learn from remembering it.
	const perPath = new Map<string, Set<string>>();
	const perHash = new Map<string, number>();
	const softDup = new Set<string>();

	return {
		checkAndCount(url): boolean {
			if (opts.maxUrlsPerPath === Infinity) return false;

			const key = url.host + url.pathname;
			let variants = perPath.get(key);
			if (variants === undefined) {
				variants = new Set();
				perPath.set(key, variants);
			}
			// a URL seen before was admitted before; re-deciding it now would make the
			// verdict depend on which page happened to link to it
			if (variants.has(url.search)) return false;
			if (variants.size >= opts.maxUrlsPerPath) return true;

			variants.add(url.search);
			return false;
		},

		countHash(contentHash, sampleUrl): boolean {
			if (opts.softDupThreshold === Infinity) return false;

			const n = (perHash.get(contentHash) ?? 0) + 1;
			perHash.set(contentHash, n);
			if (n <= opts.softDupThreshold) return false;

			if (!softDup.has(contentHash)) {
				softDup.add(contentHash);
				logger?.warn(
					`[crawl] ${n} pages share one body (hash ${contentHash}, e.g. ` +
						`${sampleUrl ?? "?"}) — treating it as a soft-404 farm: pages ` +
						`with this body are no longer expanded`,
				);
			}
			return true;
		},

		softDupHashes(): string[] {
			return [...softDup];
		},
	};
}
