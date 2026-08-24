/**
 * `./stores` — the frontier/visited persistence seam.
 *
 * Import this submodule to implement a custom store, to hold one by type, or to reach
 * for the in-memory implementations that back a default `createCrawler()` —
 * {@linkcode createMemoryFrontier} and {@linkcode createMemoryVisited}. Those two are
 * what a crawl uses when `options.stores` is absent; construct them yourself only when
 * you want to inspect crawl state from the outside, or to hand the same frontier to
 * something else.
 *
 * The same types are re-exported from the package root, so a consumer who only needs to
 * *pass* a store never has to reach for this subpath.
 *
 * @module
 */

export { createMemoryFrontier } from "./memory-frontier.ts";
export { createMemoryVisited } from "./memory-visited.ts";

export type {
	DiscoveredVia,
	FrontierItem,
	FrontierStore,
	VisitedState,
	VisitedStore,
} from "./types.ts";
