/**
 * The in-memory {@linkcode FrontierStore} — the default when `options.stores.frontier`
 * is absent, and the one every test runs against.
 *
 * The shape is dictated by what {@linkcode FrontierStore.pop} has to do: claim the
 * globally best item whose host is *not* currently excluded. A single ordered queue
 * would have to pop-and-stash its way past excluded hosts; a **min-heap per host**
 * makes exclusion a `Set` lookup and the claim an O(#hosts) scan of heap heads. Crawls
 * are host-few by nature — a many-host crawl is a PostgreSQL crawl — so that scan is
 * the cheap half of the operation.
 *
 * Nothing here persists. Resume across processes is a property of the `./pg` stores,
 * by design (doc 02 dropped checkpointing outright).
 *
 * @module
 */

import type { FrontierItem, FrontierStore } from "./types.ts";

/**
 * Binary min-heap over `(priority ASC, seq ASC)`.
 *
 * `seq` is what makes the default BFS strict FIFO within a depth: a heap is not a
 * stable sort, so without an explicit tie-breaker two items of equal priority would
 * come back in an order that depends on insertion history.
 */
class ItemHeap {
	readonly #items: FrontierItem[] = [];

	get size(): number {
		return this.#items.length;
	}

	/** `true` when `a` must pop before `b`. */
	static #before(a: FrontierItem, b: FrontierItem): boolean {
		return a.priority === b.priority ? a.seq < b.seq : a.priority < b.priority;
	}

	peek(): FrontierItem | undefined {
		return this.#items[0];
	}

	push(item: FrontierItem): void {
		const items = this.#items;
		items.push(item);
		let i = items.length - 1;
		while (i > 0) {
			const parent = (i - 1) >> 1;
			if (!ItemHeap.#before(items[i], items[parent])) break;
			[items[i], items[parent]] = [items[parent], items[i]];
			i = parent;
		}
	}

	pop(): FrontierItem | undefined {
		const items = this.#items;
		const top = items[0];
		if (top === undefined) return undefined;

		const last = items.pop()!;
		if (items.length === 0) return top;

		items[0] = last;
		let i = 0;
		for (;;) {
			const left = 2 * i + 1;
			const right = left + 1;
			let best = i;
			if (left < items.length && ItemHeap.#before(items[left], items[best])) {
				best = left;
			}
			if (right < items.length && ItemHeap.#before(items[right], items[best])) {
				best = right;
			}
			if (best === i) break;
			[items[i], items[best]] = [items[best], items[i]];
			i = best;
		}
		return top;
	}
}

/**
 * A fresh in-memory frontier.
 *
 * Upholds every rule {@linkcode FrontierStore} documents, and two more that are
 * implementation choices rather than contract:
 *
 * - **Items are copied on `push`.** A caller who keeps and mutates the object it
 *   pushed cannot reorder a heap it no longer owns. (Same reasoning as
 *   `resolveCrawlOptions` copying the arrays it is handed.)
 * - **A deferred head blocks its host.** `readyAt` is checked on the head of each
 *   host's heap only, so an item deferred into the future makes its whole host
 *   ineligible until then rather than being skipped over. Deferral comes from
 *   {@linkcode FrontierStore.release}, which the engine uses when it is *putting a
 *   host aside*, so the two agree; per-item deferral inside a busy host would need a
 *   second heap and buys nothing here.
 *
 * Memory is O(URLs ever pushed): the dedup set never forgets, because "already pushed
 * in this run, in any status" is exactly the question `push` has to answer.
 *
 * @example
 * ```ts
 * const frontier = createMemoryFrontier();
 * await frontier.push({ url: "https://a.com/", host: "a.com", depth: 0,
 *                       priority: 0, seq: 0, discoveredVia: "seed" });
 * const item = await frontier.pop();       // claimed, now in flight
 * await frontier.ack(item!.url);           // done with it
 * ```
 */
export function createMemoryFrontier(): FrontierStore {
	/** Every url ever pushed — the dedup key set. Never shrinks, by contract. */
	const pushed = new Set<string>();
	/** Pending items, bucketed by host so `pop` can skip a host in O(1). */
	const byHost = new Map<string, ItemHeap>();
	/** Claimed, not yet acked or released. */
	const inFlight = new Map<string, FrontierItem>();
	/** Pending count, maintained rather than computed — `size()` is on the hot loop. */
	let pending = 0;

	const enqueue = (item: FrontierItem): void => {
		let heap = byHost.get(item.host);
		if (heap === undefined) {
			heap = new ItemHeap();
			byHost.set(item.host, heap);
		}
		heap.push(item);
		pending++;
	};

	return {
		push(item: FrontierItem): Promise<boolean> {
			if (pushed.has(item.url)) return Promise.resolve(false);
			pushed.add(item.url);
			enqueue({ ...item });
			return Promise.resolve(true);
		},

		pop(
			filter?: { excludeHosts?: readonly string[]; now?: number },
		): Promise<FrontierItem | undefined> {
			const now = filter?.now ?? Date.now();
			const excluded = filter?.excludeHosts;

			let bestHost: string | undefined;
			let best: FrontierItem | undefined;

			for (const [host, heap] of byHost) {
				const head = heap.peek();
				// an emptied heap is dropped below, so this is a defensive read
				if (head === undefined) continue;
				if (head.readyAt !== undefined && head.readyAt > now) continue;
				if (excluded !== undefined && excluded.includes(host)) continue;
				if (
					best === undefined ||
					(head.priority === best.priority
						? head.seq < best.seq
						: head.priority < best.priority)
				) {
					best = head;
					bestHost = host;
				}
			}

			if (best === undefined || bestHost === undefined) {
				return Promise.resolve(undefined);
			}

			const heap = byHost.get(bestHost)!;
			const item = heap.pop()!;
			if (heap.size === 0) byHost.delete(bestHost);
			pending--;
			inFlight.set(item.url, item);
			return Promise.resolve(item);
		},

		ack(url: string): Promise<void> {
			// tolerant: acking something that is not in flight is a no-op, never an
			// error — a store is not the place to police the engine's bookkeeping
			inFlight.delete(url);
			return Promise.resolve();
		},

		release(url: string, readyAt?: number): Promise<void> {
			const item = inFlight.get(url);
			if (item === undefined) return Promise.resolve();
			inFlight.delete(url);
			enqueue(readyAt === undefined ? item : { ...item, readyAt });
			return Promise.resolve();
		},

		size(): Promise<number> {
			return Promise.resolve(pending);
		},
	};
}
