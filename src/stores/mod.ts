/**
 * `./stores` — the frontier/visited persistence seam.
 *
 * Import this submodule to implement a custom store, or to hold one by type. The
 * in-memory implementations that back a default `createCrawler()` land here too (they
 * are not written yet — see the roadmap).
 *
 * The same types are re-exported from the package root, so a consumer who only needs to
 * *pass* a store never has to reach for this subpath.
 *
 * @module
 */

export type {
	DiscoveredVia,
	FrontierItem,
	FrontierStore,
	VisitedState,
	VisitedStore,
} from "./types.ts";
