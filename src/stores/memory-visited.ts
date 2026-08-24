/**
 * The in-memory {@linkcode VisitedStore} — a `Map`, with one rule that is not a `Map`.
 *
 * @module
 */

import type { VisitedState, VisitedStore } from "./types.ts";

/**
 * A fresh in-memory visited set.
 *
 * `hasBody` is **always `false`**, whatever the caller passes, and that is deliberate
 * rather than lazy: `hasBody` tells the engine it may seed `If-None-Match` /
 * `If-Modified-Since` on a re-crawl, and a `304 Not Modified` is only useful when
 * there is a stored body to re-extract links from. This store keeps no bodies, so a
 * `true` here would turn every unchanged page into a page with no links — a silently
 * broken re-crawl. Memory-mode re-crawls therefore always re-fetch in full and detect
 * change through `contentHash`, which is what {@linkcode VisitedState.hasBody}
 * documents.
 *
 * States are copied in and out, so neither side can mutate the other's object.
 *
 * @example
 * ```ts
 * const visited = createMemoryVisited();
 * await visited.add("https://a.com/", { status: 200, crawledAt: Date.now() });
 * await visited.has("https://a.com/"); // => true
 * ```
 */
export function createMemoryVisited(): VisitedStore {
	const seen = new Map<string, VisitedState>();

	return {
		has(url: string): Promise<boolean> {
			return Promise.resolve(seen.has(url));
		},

		add(url: string, state: VisitedState): Promise<void> {
			// upsert, replacing rather than merging: the last completion is the truth
			// about a URL, and a redirect intermediate's minimal state must not be
			// able to resurrect a field from an earlier, fuller record
			seen.set(url, { ...state, hasBody: false });
			return Promise.resolve();
		},

		get(url: string): Promise<VisitedState | undefined> {
			const state = seen.get(url);
			return Promise.resolve(state === undefined ? undefined : { ...state });
		},

		count(): Promise<number> {
			return Promise.resolve(seen.size);
		},
	};
}
