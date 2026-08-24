/**
 * The persistence seam: what the crawl engine needs from a frontier and from a visited
 * set, and nothing more.
 *
 * These two interfaces are the entire contract between the engine and whatever holds
 * crawl state — the in-memory defaults, or the PostgreSQL stores of the `./pg`
 * submodule. They are shaped for the harder of the two: {@linkcode FrontierStore.pop}
 * is a **claim**, not a dequeue, so a SQL implementation can be one
 * `SELECT … FOR UPDATE SKIP LOCKED` + `UPDATE`, and so a crashed run can resume the
 * items it had in flight.
 *
 * @module
 */

import type { DiscoveredVia } from "../types.ts";

// Note: the `../types.ts` import above is type-only and so is that module's import of
// this one. The cycle is erased at compile time — there is no runtime cycle, and both
// files stay where a reader would look for them.

export type { DiscoveredVia };

/**
 * One unit of work in the frontier: a normalized URL plus everything the dispatcher
 * needs to decide *when* it may be fetched and everything the resulting
 * {@linkcode "../types.ts".PageResult} inherits from its discovery.
 */
export interface FrontierItem {
	/**
	 * The normalized URL (see `normalizeUrl`) — and the dedup key. Two items with this
	 * same string are the same item, which is why normalization correctness is a
	 * frontier concern and not a cosmetic one.
	 */
	url: string;
	/** Hostname of {@linkcode url}, denormalized so politeness can filter on it. */
	host: string;
	/** Link distance from the nearest seed at first discovery. Seeds are `0`. */
	depth: number;
	/**
	 * Sort key — **lower pops first**. The engine derives it from
	 * `CrawlOptions.strategy`: `"bfs"` → `depth`, `"dfs"` → `-depth`, `"priority"` →
	 * the user's `priority(item)`.
	 */
	priority: number;
	/**
	 * Engine-assigned monotonic counter, used only to break {@linkcode priority} ties.
	 * It is what makes the default BFS strict FIFO within a depth.
	 */
	seq: number;
	/** URL of the page this item was discovered on, when it was discovered on one. */
	referrer?: string;
	/** How this URL entered the frontier. */
	discoveredVia: DiscoveredVia;
	/**
	 * Epoch ms before which this item is not eligible to pop. Set by
	 * {@linkcode FrontierStore.release} deferrals; absent means "eligible now".
	 *
	 * Per-host politeness delays are **not** expressed here — those are engine-side
	 * state passed to {@linkcode FrontierStore.pop} as `excludeHosts`. This field
	 * exists for per-item deferral and for future multi-process schedulers.
	 */
	readyAt?: number;
	/** Arbitrary payload from `Crawler.add()` / seed init; echoed on `PageResult`. */
	meta?: Record<string, unknown>;
}

/**
 * The queue of URLs to fetch, with a **claim/ack lifecycle**.
 *
 * Implementations must uphold these rules; the engine relies on them and so does the
 * PostgreSQL store:
 *
 * - {@linkcode push} is the *only* place duplicates are rejected, and it must be
 *   atomic — `false` is the definitive "already seen in this run" answer.
 * - A successful {@linkcode pop} moves the item to in-flight. Exactly one
 *   {@linkcode ack} or {@linkcode release} follows it.
 * - {@linkcode size} counts *pending* items only. `pop()` returning `undefined`
 *   therefore means "nothing eligible right now", **not** "the crawl is done" — the
 *   engine distinguishes the two by also checking `size()` and its in-flight count.
 * - The engine never calls `pop` concurrently with itself (single dispatcher loop).
 */
export interface FrontierStore {
	/**
	 * Insert `item` unless its `url` was ever pushed in this run — in **any** status,
	 * including already fetched.
	 *
	 * @returns `true` iff inserted. `false` is the duplicate signal the engine records
	 * as `skipReason: "duplicate"`.
	 */
	push(item: FrontierItem): Promise<boolean>;
	/**
	 * Claim the next eligible item, atomically marking it in-flight.
	 *
	 * Eligible means: status pending, `(readyAt ?? 0) <= now`, and `host` not in
	 * `excludeHosts`. Ordering is `(priority ASC, seq ASC)`.
	 *
	 * @param filter.excludeHosts Hosts currently at their concurrency cap or inside
	 * their politeness delay window.
	 * @param filter.now Clock override (epoch ms) — injected by tests.
	 * @returns The claimed item, or `undefined` when nothing is eligible *right now*.
	 */
	pop(
		filter?: { excludeHosts?: readonly string[]; now?: number },
	): Promise<FrontierItem | undefined>;
	/** Terminal ack of a claimed item: fetched, failed terminally, or skipped post-claim. */
	ack(url: string): Promise<void>;
	/**
	 * Return a claimed item to pending — used when a run is aborted with items in
	 * flight, so a resumable store can hand them out again.
	 *
	 * @param readyAt Epoch ms before which the item stays ineligible.
	 */
	release(url: string, readyAt?: number): Promise<void>;
	/** Number of pending items. In-flight items are **not** counted. */
	size(): Promise<number>;
}

/**
 * The set of URLs this crawl has already completed, with just enough per-URL state to
 * support conditional re-fetching and change detection.
 */
export interface VisitedStore {
	has(url: string): Promise<boolean>;
	/** Upsert. Called at completion — success or terminal error. */
	add(url: string, state: VisitedState): Promise<void>;
	get(url: string): Promise<VisitedState | undefined>;
	count(): Promise<number>;
}

/** What {@linkcode VisitedStore} remembers about one completed URL. */
export interface VisitedState {
	/** Final HTTP status, when there was one. */
	status?: number;
	/** SHA-256 hex of the raw response bytes — the change-detection key. */
	contentHash?: string;
	/** `ETag` response header → `If-None-Match` on re-crawl. */
	etag?: string;
	/** `Last-Modified` response header → `If-Modified-Since` on re-crawl. */
	lastModified?: string;
	/** Epoch ms of completion. */
	crawledAt?: number;
	/** `FetchResult.attempts` — the transport layer's try count, not a crawl retry. */
	attempts?: number;
	/**
	 * True when the backing store actually holds this URL's body.
	 *
	 * This gates conditional-header seeding on re-crawl: a `304 Not Modified` is only
	 * useful if there is a stored body to re-extract links from. The memory stores keep
	 * no bodies and always report `false`, so memory-mode re-crawls always re-fetch in
	 * full and detect change via {@linkcode contentHash}.
	 */
	hasBody?: boolean;
}
