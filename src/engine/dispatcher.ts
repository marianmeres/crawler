/**
 * Internal — the crawl engine: the dispatcher loop, the worker pool, per-host
 * politeness, link processing and the streaming `run()` iterator.
 *
 * This is the hardest code in the package, so the shape is deliberately boring:
 *
 * - **One dispatcher loop.** It is the only thing that calls
 *   {@linkcode "../stores/types.ts".FrontierStore.pop}, which is why the store contract
 *   can promise "never called concurrently with itself" and why a PostgreSQL frontier
 *   can be a single `SELECT … FOR UPDATE SKIP LOCKED`.
 * - **Workers are plain promises in a `Set`** — no recursion, no worker classes. Each
 *   one claims exactly one item, fetches it, and acks it.
 * - **Nothing polls.** When there is no eligible work the loop parks on a promise that
 *   a completion resolves, raced against a single `setTimeout` armed for the earliest
 *   host that is inside its politeness window.
 * - **Backpressure is two-sided**: the global in-flight cap stops the dispatcher, and
 *   the bounded {@linkcode Channel} parks the workers when the consumer of `run()` is
 *   slower than the crawl.
 *
 * The engine never opens a socket (that is `@marianmeres/page-fetcher`) and never
 * retries a page (page-fetcher already did): a terminal fetch error is a
 * {@linkcode "../types.ts".PageResult} carrying `error`, not a re-queue.
 *
 * @module
 */

import { createFetcher, PageFetchError } from "@marianmeres/page-fetcher";
import type {
	Fetcher,
	FetchFn,
	FetchRequest,
	FetchResult,
} from "@marianmeres/page-fetcher";

import { extractBaseHref, extractLinks, extractTitle } from "../extract/extract-links.ts";
import { parseMetaRobots, parseXRobotsTag } from "../extract/meta-robots.ts";
import type { ExtractLinksOptions } from "../extract/extract-links.ts";
import type { RobotsDirectives } from "../extract/meta-robots.ts";
import type { RawLink } from "../extract/types.ts";
import { resolveCrawlOptions } from "../options.ts";
import type { ResolvedCrawlOptions } from "../options.ts";
import { createMemoryFrontier } from "../stores/memory-frontier.ts";
import { createMemoryVisited } from "../stores/memory-visited.ts";
import type { FrontierItem, FrontierStore, VisitedStore } from "../stores/types.ts";
import type {
	CrawlEvents,
	CrawlOptions,
	CrawlReport,
	CrawlStats,
	DiscoveredVia,
	LinkRecord,
	PageContext,
	PageResult,
	SkipReason,
	StoppedBy,
} from "../types.ts";
import { classifyLink } from "../url/same-site.ts";
import { normalizeUrl } from "../url/normalize-url.ts";
import { Channel } from "./channel.ts";
import { createRobotsGate } from "./robots-gate.ts";
import type { RobotsGate } from "./robots-gate.ts";
import { evaluateScope, isOnSeedSite } from "./scope.ts";
import type { ScopeContext } from "./scope.ts";
import { createStatsCounter, safeEmit } from "./stats.ts";
import type { StatsCounter } from "./stats.ts";
import { createTrapTracker, detectUrlTrap } from "./traps.ts";
import type { TrapTracker } from "./traps.ts";

/** Content types the engine will look for links in. Anything else is fetched, not read. */
const HTML_CONTENT_TYPES: ReadonlySet<string> = new Set([
	"text/html",
	"application/xhtml+xml",
]);

/**
 * How long the loop naps when a custom {@linkcode "../stores/types.ts".FrontierStore}
 * reports pending work that nothing eligible can explain.
 *
 * The engine's own deferrals are all host-scheduled and produce an exact wake-up time;
 * this is the backstop for a store that defers *items* (`release(url, readyAt)`), where
 * the engine has no way to know when the item becomes eligible. Without it that
 * situation would be a busy loop.
 */
const IDLE_NAP_MS = 50;

/** How many redirect hops of one response are marked visited. Purely a sanity bound. */
const MAX_RECORDED_REDIRECTS = 50;

/** Per-host scheduling state owned by the dispatcher. */
interface HostState {
	/** Workers currently fetching this host. */
	inFlight: number;
	/** Epoch ms before which this host must not be dispatched to again. */
	nextReadyAt: number;
}

/**
 * The outcome of trying to put one URL into the frontier. Every failure member is also a
 * {@linkcode SkipReason}, so a caller records the outcome as-is.
 */
type EnqueueOutcome =
	| "pushed"
	| Extract<SkipReason, "duplicate" | "queue-full" | "max-pages">;

/** A URL the consumer handed us through {@linkcode CrawlEngine.add}. */
interface ManualAdd {
	url: string;
	depth: number;
	meta?: Record<string, unknown>;
}

/**
 * A single-use crawl.
 *
 * One instance per {@linkcode "../crawler.ts".createCrawler} call; `run()` may be
 * entered exactly once. Everything the public {@linkcode "../types.ts".Crawler} handle
 * exposes is a thin delegation to a method here.
 */
export class CrawlEngine {
	readonly crawlId: string = crypto.randomUUID();

	readonly #opts: ResolvedCrawlOptions;
	readonly #frontier: FrontierStore;
	readonly #visited: VisitedStore;

	/** Set at `run()`; owned (and therefore disposed) only when we built it ourselves. */
	#fetch: FetchFn | undefined;
	#ownedFetcher: Fetcher | undefined;

	#channel: Channel<PageResult> | undefined;
	#stats: StatsCounter;
	/** Per-run trap counters. In memory even in PG mode — see `./traps.ts`. */
	readonly #traps: TrapTracker;
	/** Built at `run()`, once the transport it may borrow is known. */
	#robots: RobotsGate | undefined;

	// --- dispatcher state ---
	readonly #hosts = new Map<string, HostState>();
	readonly #workers = new Set<Promise<void>>();
	#globalInFlight = 0;
	/** Pending frontier items, mirrored locally so `stats()` can stay synchronous. */
	#queued = 0;
	/** Monotonic tie-breaker; what makes the default BFS strict FIFO within a depth. */
	#seq = 0;
	#dispatching = false;
	#loop: Promise<void> | undefined;

	/** Resolved by every completion, so the loop can park instead of polling. */
	#wake: () => void = () => {};
	#wakePromise: Promise<void> = Promise.resolve();

	// --- lifecycle ---
	#started = false;
	#seedHosts: string[] = [];
	#manual: ManualAdd[] = [];
	readonly #abortController = new AbortController();
	#aborting = false;
	#stoppedBy: StoppedBy | undefined;
	#stoppedReason: string | undefined;
	#startPromise: Promise<void> | undefined;
	#shutdownPromise: Promise<void> | undefined;
	#finalizePromise: Promise<void> | undefined;
	#report: CrawlReport | undefined;
	/** Armed at `run()` only when there is an `onProgress` handler to feed. */
	#progressTimer: ReturnType<typeof setInterval> | undefined;
	/** Armed at `run()` only when `maxDuration` is finite — the whole of that budget. */
	#deadlineTimer: ReturnType<typeof setTimeout> | undefined;

	// --- collected output ---
	readonly #pages: PageResult[] = [];
	readonly #graph: LinkRecord[] = [];

	// --- one-shot warnings ---
	#warnedRegionFallback = false;
	#warnedBeforeExtract = false;
	#warnedPriority = false;

	// --- precomputed extraction option sets (see `#extract`) ---
	readonly #extractAll: ExtractLinksOptions;
	readonly #extractHead: ExtractLinksOptions;
	readonly #extractBody: ExtractLinksOptions;

	constructor(options: CrawlOptions = {}) {
		this.#opts = resolveCrawlOptions(options);
		this.#frontier = this.#opts.stores.frontier ?? createMemoryFrontier();
		this.#visited = this.#opts.stores.visited ?? createMemoryVisited();
		this.#stats = createStatsCounter(this.crawlId, { maxPages: this.#opts.maxPages });
		this.#traps = createTrapTracker(this.#opts.traps, this.#opts.logger);

		const extract = this.#opts.extract;
		this.#extractAll = { ...extract };
		// `<head>`-derived sources and body sources, for the two-pass `beforeExtract`
		// split. `detectBase` is off on both: the effective base is computed once from
		// the RAW document, because narrowing throws `<head>` (and with it `<base>`)
		// away and a body pass that re-derived its own base would resolve every
		// relative link against the wrong origin.
		this.#extractHead = {
			...extract,
			anchors: false,
			iframes: false,
			assets: false,
			srcset: false,
			detectBase: false,
		};
		this.#extractBody = {
			...extract,
			canonical: false,
			nextPrev: false,
			metaRefresh: false,
			alternate: false,
			detectBase: false,
		};

		this.#opts.signal?.addEventListener(
			"abort",
			() => this.abort("signal"),
			{ once: true },
		);
	}

	/** The resolved options — what `events.onStart` reports and the engine actually runs. */
	get options(): ResolvedCrawlOptions {
		return this.#opts;
	}

	// -------------------------------------------------------------------------------
	// public surface (mirrors `Crawler`)
	// -------------------------------------------------------------------------------

	/**
	 * Queue URLs by hand. Synchronous by contract, so the work is only *recorded* here;
	 * the dispatcher loop drains the list, which is also what keeps `add()` from racing
	 * the loop's "is the crawl finished?" check.
	 */
	add(
		urls: string | string[],
		init?: { depth?: number; meta?: Record<string, unknown> },
	): void {
		const depth = Number.isFinite(init?.depth)
			? Math.max(0, init!.depth as number)
			: 0;
		for (const raw of Array.isArray(urls) ? urls : [urls]) {
			const url = this.#normalizeEntryUrl(raw);
			if (url === null) {
				this.#opts.logger?.warn(`[crawl] add(): not a usable URL: ${raw}`);
				continue;
			}
			this.#manual.push({ url, depth, meta: init?.meta });
		}
		this.#signal();
	}

	/** The primary API. Single-use — a second call throws. */
	run(seeds?: string | string[]): AsyncIterableIterator<PageResult> {
		if (this.#started) {
			throw new Error(`[crawler] run() is single-use — this crawl already started`);
		}
		this.#started = true;
		return this.#iterate(seeds);
	}

	/** Graceful: stop dispatching, let in-flight pages finish and be delivered. */
	stop(reason?: string): Promise<void> {
		return this.#shutdown("stop", reason, false);
	}

	/** Hard: abort in-flight fetches and release their frontier claims. */
	abort(reason?: string): void {
		this.#aborting = true;
		void this.#shutdown("abort", reason, false).catch(() => {});
	}

	/** Live snapshot. Cheap counter reads plus two small object copies. */
	stats(): CrawlStats {
		return this.#stats.snapshot({
			queued: this.#queued,
			inFlight: this.#globalInFlight,
		});
	}

	/** The final report, or `undefined` while the run is still going. */
	report(): CrawlReport | undefined {
		return this.#report;
	}

	/** `abort()` plus disposal of engine-owned fetchers. */
	async dispose(): Promise<void> {
		if (!this.#started) {
			// a crawler that never ran owns nothing
			await this.#disposeFetcher();
			return;
		}
		this.#aborting = true;
		await this.#shutdown("abort", "dispose", true);
	}

	// -------------------------------------------------------------------------------
	// run / shutdown
	// -------------------------------------------------------------------------------

	async *#iterate(seeds?: string | string[]): AsyncGenerator<PageResult> {
		const channel = new Channel<PageResult>(this.#opts.concurrency * 2);
		this.#channel = channel;

		try {
			this.#startPromise = this.#start(seeds);
			await this.#startPromise;
			while (true) {
				const next = await channel.next();
				if (next.done) break;
				yield next.value;
			}
			// the loop ended on its own — whatever latched the stop already did
			await this.#shutdown(
				this.#stoppedBy ?? "completed",
				this.#stoppedReason,
				false,
			);
		} finally {
			// a consumer `break` lands here with the channel still open: dispatching
			// stops, in-flight pages drain and are still recorded, but their results
			// are discarded rather than delivered — there is nobody left to deliver to
			await this.#shutdown("stop", "consumer-break", true);
		}
	}

	/** Resolve the transport, seed the frontier, start the dispatcher. */
	async #start(seeds?: string | string[]): Promise<void> {
		this.#stats = createStatsCounter(this.crawlId, { maxPages: this.#opts.maxPages });
		this.#resolveFetch();
		this.#resolveRobots();

		const list = seeds === undefined ? [] : Array.isArray(seeds) ? seeds : [seeds];

		// seed hosts first: they define the crawl's site, so every later scope check
		// (including the seeds' own) needs the complete set up front
		const normalized: string[] = [];
		for (const seed of list) {
			const url = this.#normalizeEntryUrl(seed);
			if (url === null) {
				this.#opts.logger?.warn(`[crawl] seed is not a usable URL: ${seed}`);
				continue;
			}
			normalized.push(url);
		}
		this.#seedHosts = [...new Set(normalized.map((u) => hostOf(u)))].filter(
			(h) => h !== "",
		);

		// before the first seed is enqueued, so nothing can be observed ahead of it.
		// `seeds` is what the crawl actually starts from (normalized, unusable ones
		// already dropped) and `options` the post-defaults snapshot the engine runs —
		// handed over as a copy, because the list below is still about to be read and a
		// handler is not allowed to change what gets crawled.
		this.#emit("onStart", (h) =>
			h({
				crawlId: this.crawlId,
				seeds: [...normalized],
				options: this.#opts,
			}));
		this.#armProgress();
		this.#armDeadline();

		for (const url of normalized) await this.#enqueueSeed(url);

		// `stop()`, `abort()` or `dispose()` can land while the seeds are still being
		// enqueued — starting the dispatcher after that point would resurrect a crawl
		// that has already been shut down and finalized
		if (this.#shutdownPromise !== undefined) return;

		this.#dispatching = true;
		this.#loop = this.#dispatch();
		// a loop failure is a crawl failure: surface it on the iterator rather than as
		// an unhandled rejection
		void this.#loop.catch((e) => this.#channel?.fail(e));
	}

	/**
	 * Stop the run and finalize. Idempotent — the first caller decides how it ends, and
	 * everyone awaits the same promise.
	 *
	 * @param discard Close the channel *before* draining, so in-flight results are
	 * recorded but never delivered. That is the consumer-`break` path; a plain `stop()`
	 * delivers what is already in flight.
	 */
	#shutdown(
		stoppedBy: StoppedBy,
		reason: string | undefined,
		discard: boolean,
	): Promise<void> {
		// `abort` outranks a latched stop; otherwise the first latch wins
		if (this.#stoppedBy === undefined || stoppedBy === "abort") {
			this.#stoppedBy = stoppedBy;
			if (reason !== undefined) this.#stoppedReason = reason;
		}
		if (this.#shutdownPromise !== undefined) return this.#shutdownPromise;

		this.#shutdownPromise = (async () => {
			this.#dispatching = false;
			this.#signal();

			if (discard) {
				this.#channel?.close();
			} else {
				// stop applying backpressure, so a worker parked on `push()` cannot
				// deadlock a consumer that awaits `stop()` instead of iterating on
				this.#channel?.relax();
			}

			if (stoppedBy === "abort") this.#abortController.abort(reason);

			// startup owns `#loop`, so it has to settle before we can wait on it
			try {
				await this.#startPromise;
			} catch {
				// already reported through the channel
			}
			try {
				await this.#loop;
			} catch {
				// already reported through the channel
			}
			while (this.#workers.size > 0) await Promise.all([...this.#workers]);

			this.#channel?.close();
			await this.#finalize();
		})();

		return this.#shutdownPromise;
	}

	/** Dispose engine-owned transport and freeze the report. Idempotent. */
	#finalize(): Promise<void> {
		this.#finalizePromise ??= (async () => {
			this.#disarmProgress();
			this.#disarmDeadline();
			await this.#disposeFetcher();
			this.#report = {
				crawlId: this.crawlId,
				pages: this.#pages,
				graph: this.#graph,
				stats: this.stats(),
				stoppedBy: this.#stoppedBy ?? "completed",
				...(this.#stoppedReason === undefined
					? {}
					: { stoppedReason: this.#stoppedReason }),
			};
			// the guaranteed last progress emit: whatever the throttle did or did not
			// get around to, a consumer's final snapshot is never a stale one
			this.#emitProgress();
			this.#emit("onEnd", (h) => h(this.#report!));
		})();
		return this.#finalizePromise;
	}

	// -------------------------------------------------------------------------------
	// events
	// -------------------------------------------------------------------------------

	/**
	 * Fire one event, if anyone is listening. See
	 * {@linkcode "./stats.ts".safeEmit} for why nothing here can fail a crawl.
	 */
	#emit<K extends keyof CrawlEvents>(
		name: K,
		call: (handler: NonNullable<CrawlEvents[K]>) => unknown,
	): void {
		const handler = this.#opts.events[name];
		if (handler === undefined) return;
		safeEmit(
			name,
			() => call(handler as NonNullable<CrawlEvents[K]>),
			this.#opts.logger,
		);
	}

	#emitProgress(): void {
		this.#emit("onProgress", (h) => h(this.stats()));
	}

	#armProgress(): void {
		if (this.#opts.events.onProgress === undefined) return;
		this.#progressTimer = setInterval(
			() => this.#emitProgress(),
			this.#opts.progressInterval,
		);
	}

	#disarmProgress(): void {
		if (this.#progressTimer === undefined) return;
		clearInterval(this.#progressTimer);
		this.#progressTimer = undefined;
	}

	// -------------------------------------------------------------------------------
	// budgets
	// -------------------------------------------------------------------------------

	/**
	 * The `maxDuration` budget: one timer, armed here and cleared at finalization.
	 *
	 * It takes the same graceful path as the other two — in-flight pages drain and are
	 * still delivered, so a crawl can (and routinely does) outlive its deadline by one
	 * slow response. Per-request hard limits are page-fetcher's `deadline`, not this.
	 */
	#armDeadline(): void {
		if (!Number.isFinite(this.#opts.maxDuration)) return;
		this.#deadlineTimer = setTimeout(
			() => void this.#shutdown("maxDuration", undefined, false),
			this.#opts.maxDuration,
		);
	}

	#disarmDeadline(): void {
		if (this.#deadlineTimer === undefined) return;
		clearTimeout(this.#deadlineTimer);
		this.#deadlineTimer = undefined;
	}

	/**
	 * The one place `maxPages` and `maxTotalBytes` are enforced. Called after every
	 * completion, because both count completions.
	 *
	 * Precedence is entirely {@linkcode CrawlEngine.#shutdown}'s: the first stop to latch
	 * wins, so an already-latched `stop()` keeps its `stoppedBy` and only `abort`
	 * overrides. The early return is the same rule, said locally.
	 */
	#checkBudgets(): void {
		if (this.#stoppedBy !== undefined) return;
		if (this.#pageCapReached()) {
			void this.#shutdown("maxPages", undefined, false);
		} else if (this.#stats.bytes >= this.#opts.maxTotalBytes) {
			void this.#shutdown("maxTotalBytes", undefined, false);
		}
	}

	/**
	 * Has `maxPages` been spent? Completions only — a page in flight has not been paid
	 * for yet, which is why the cap can be reached mid-fetch and still deliver more
	 * pages than it names.
	 */
	#pageCapReached(): boolean {
		return this.#stats.done + this.#stats.failed >= this.#opts.maxPages;
	}

	// -------------------------------------------------------------------------------
	// dispatcher
	// -------------------------------------------------------------------------------

	async #dispatch(): Promise<void> {
		while (this.#dispatching) {
			await this.#drainManual();
			if (!this.#dispatching) break;

			if (this.#globalInFlight >= this.#opts.concurrency) {
				await this.#park();
				continue;
			}

			const now = Date.now();
			const item = await this.#frontier.pop({
				excludeHosts: this.#excludedHosts(now),
				now,
			});

			if (item !== undefined) {
				// a budget (or `stop()`) can latch while this pop is in flight, and
				// "dispatch stops" has to mean it: hand the claim back rather than
				// start a fetch nobody asked for any more
				if (!this.#dispatching) {
					await this.#frontier.release(item.url);
					break;
				}
				this.#queued = Math.max(0, this.#queued - 1);
				this.#dispatchItem(item);
				continue;
			}

			// nothing eligible: either the crawl is finished, or everything is behind
			// a politeness window or an in-flight page
			if (this.#globalInFlight === 0 && this.#manual.length === 0) {
				const pending = await this.#frontier.size();
				// re-read: `add()` is synchronous from the consumer's side and can
				// land during the await above
				if (
					pending === 0 && this.#globalInFlight === 0 &&
					this.#manual.length === 0
				) {
					break;
				}
			}
			await this.#park(this.#nextWakeDelay(Date.now()));
		}

		if (this.#dispatching) {
			// ran dry on its own
			this.#dispatching = false;
			void this.#shutdown("completed", undefined, false);
		}
	}

	/** Hosts that must not be popped right now, and why they must not. */
	#excludedHosts(now: number): string[] {
		const excluded: string[] = [];
		for (const [host, state] of this.#hosts) {
			if (
				state.inFlight >= this.#opts.perHostConcurrency ||
				state.nextReadyAt > now
			) {
				excluded.push(host);
			}
		}
		return excluded;
	}

	/**
	 * ms until the earliest host leaves its politeness window, or `undefined` when the
	 * only thing worth waiting for is a completion.
	 */
	#nextWakeDelay(now: number): number | undefined {
		let earliest = Infinity;
		for (const state of this.#hosts.values()) {
			if (state.nextReadyAt > now && state.nextReadyAt < earliest) {
				earliest = state.nextReadyAt;
			}
		}
		if (earliest !== Infinity) return Math.max(0, earliest - now);
		// no timed host and nothing in flight, yet the frontier says it has work: only
		// a store-side deferral can explain that, and we have no wake-up time for it
		return this.#globalInFlight === 0 ? IDLE_NAP_MS : undefined;
	}

	#dispatchItem(item: FrontierItem): void {
		const state = this.#hostState(item.host);
		const delay = Math.max(this.#opts.perHostDelay, this.#crawlDelayMs(item.host));

		state.inFlight++;
		// measured from dispatch, not from completion: a slow page must not also cost
		// its host the delay
		state.nextReadyAt = Date.now() + delay;
		this.#globalInFlight++;

		const worker = this.#runWorker(item, state);
		this.#workers.add(worker);
		void worker.then(() => this.#workers.delete(worker));
	}

	/** Never rejects — a worker's failure is data, not a crash. */
	async #runWorker(item: FrontierItem, state: HostState): Promise<void> {
		try {
			await this.#fetchOne(item);
		} catch (e) {
			this.#opts.logger?.error(`[crawl] worker failed on ${item.url}:`, e);
		} finally {
			state.inFlight--;
			this.#globalInFlight--;
			this.#signal();
		}
	}

	#hostState(host: string): HostState {
		let state = this.#hosts.get(host);
		if (state === undefined) {
			state = { inFlight: 0, nextReadyAt: 0 };
			this.#hosts.set(host, state);
		}
		return state;
	}

	/** robots.txt `Crawl-delay` for a host, in ms, capped. `0` when there is none. */
	#crawlDelayMs(host: string): number {
		return this.#robots?.crawlDelayMs(host) ?? 0;
	}

	/** Park until a completion signal, optionally with a timeout. */
	async #park(timeoutMs?: number): Promise<void> {
		if (timeoutMs === undefined) {
			await this.#wakePromise;
			return;
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				this.#wakePromise,
				new Promise<void>((resolve) => {
					timer = setTimeout(resolve, timeoutMs);
				}),
			]);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	}

	/** Wake the dispatcher. Cheap and safe to call more often than necessary. */
	#signal(): void {
		const wake = this.#wake;
		this.#wakePromise = new Promise<void>((resolve) => {
			this.#wake = resolve;
		});
		wake();
	}

	// -------------------------------------------------------------------------------
	// worker
	// -------------------------------------------------------------------------------

	async #fetchOne(item: FrontierItem): Promise<void> {
		const checkOnly = this.#isCheckOnly(item.url);
		const startedAt = Date.now();

		this.#emit("onPageStart", (h) => h(item));

		let fetchResult: FetchResult | undefined;
		let error: PageResult["error"] | undefined;
		// what was actually thrown, kept beside its flattened `PageResult["error"]`
		// twin: `onPageError` hands the observer the original (stack and all), the
		// result carries the serializable shape
		let thrown: unknown;

		try {
			fetchResult = await this.#fetch!({
				url: item.url,
				signal: this.#requestSignal(),
				retainBody: !checkOnly,
				headers: await this.#conditionalHeaders(item),
				meta: {
					crawlId: this.crawlId,
					depth: item.depth,
					referrer: item.referrer,
				},
			});
		} catch (e) {
			error = toPageError(e);
			thrown = e;
		}

		// an abort releases the claim instead of consuming it, so a resumable store can
		// hand the item out again on the next run. It is also the one path where an
		// `onPageStart` is not followed by an `onPageDone`: the page was never a page.
		if (error?.kind === "aborted" && this.#aborting) {
			await this.#frontier.release(item.url);
			this.#queued++;
			return;
		}

		const fetchMs = fetchResult?.timing.total ?? Date.now() - startedAt;
		const extractStartedAt = Date.now();

		const result: PageResult = {
			crawlId: this.crawlId,
			requestId: fetchResult?.requestId ?? crypto.randomUUID(),
			url: item.url,
			finalUrl: fetchResult?.finalUrl ?? item.url,
			redirects: fetchResult?.redirects ?? [],
			status: fetchResult?.status ?? 0,
			ok: false,
			depth: item.depth,
			discoveredVia: item.discoveredVia,
			attempts: fetchResult?.attempts ?? 0,
			timing: { total: 0, fetch: fetchMs, extract: 0 },
			fromCache: fetchResult?.fromCache ?? false,
			notModified: (fetchResult?.notModified ?? false) ||
				fetchResult?.status === 304,
			links: [],
		};
		if (item.referrer !== undefined) result.referrer = item.referrer;
		if (item.meta !== undefined) result.meta = item.meta;
		if (fetchResult?.contentType !== undefined) {
			result.contentType = fetchResult.contentType;
		}
		if (fetchResult?.charset !== undefined) result.charset = fetchResult.charset;
		if (fetchResult?.size !== undefined) result.size = fetchResult.size;

		let bytes: Uint8Array | undefined;
		let html: string | undefined;
		// `true` once this body has been seen more often than `traps.softDupThreshold`
		// allows: the page is still fetched, delivered and reported, it is simply no
		// longer a source of new work
		let softDup = false;

		if (error === undefined && fetchResult !== undefined) {
			// `X-Robots-Tag` applies to every response, not only to documents — a PDF
			// can carry a `noindex` that no `<meta>` ever could
			const header = parseXRobotsTag(fetchResult.headers.get("x-robots-tag"), {
				botName: this.#opts.userAgent,
			});
			try {
				if (fetchResult.hasBody) {
					bytes = await fetchResult.bytes();
					result.contentHash = await sha256Hex(bytes);
					softDup = this.#traps.countHash(result.contentHash, result.url);
					if (
						!checkOnly &&
						HTML_CONTENT_TYPES.has(fetchResult.contentType ?? "")
					) {
						html = await fetchResult.text();
					}
				}
				if (html !== undefined) {
					await this.#readDocument(
						result,
						item,
						html,
						fetchResult,
						header,
						softDup,
					);
				} else {
					applyRobots(result, header);
				}
			} catch (e) {
				// extraction and the hooks it runs produce data; a throw fails the page
				error = toPageError(e);
				thrown = e;
			}
		}

		if (error !== undefined) result.error = error;
		result.ok = error === undefined &&
			fetchResult !== undefined &&
			(fetchResult.ok || fetchResult.status === 304);

		result.timing.extract = Date.now() - extractStartedAt;
		result.timing.total = result.timing.fetch + result.timing.extract;

		const ctx: PageContext = {
			crawlId: this.crawlId,
			requestId: result.requestId,
			item,
			stats: this.stats(),
		};
		if (fetchResult !== undefined) ctx.fetchResult = fetchResult;

		if (this.#opts.onPage !== undefined) {
			try {
				result.data = await this.#opts.onPage(result, ctx);
			} catch (e) {
				if (result.error === undefined) {
					result.error = toPageError(e);
					thrown = e;
				}
				result.ok = false;
			}
		}

		// counted only now: `onPage` is documented as running before the page is
		// yielded, and a hook that throws FAILS the page — so whether this one lands in
		// `done` or in `failed` is not settled until the hook has had its say. (Which
		// is also why `ctx.stats` above does not include it: it is still `inFlight`.)
		this.#stats.recordPage({
			ok: result.ok,
			status: result.status,
			host: item.host,
			size: result.size,
		});
		this.#checkBudgets();

		// a failed page is announced twice on purpose: `onPageError` for the observer
		// that only cares about failures, `onPageDone` for the one that persists every
		// outcome and would otherwise have to subscribe to both
		if (result.error !== undefined) {
			this.#emit("onPageError", (h) => h(thrown, item));
		}
		this.#emit("onPageDone", (h) => h(result, ctx));

		if (this.#opts.collect.pages) this.#pages.push(result);
		await this.#channel!.push(result);

		await this.#frontier.ack(item.url);
		await this.#recordVisited(item, result, fetchResult);
	}

	/** The per-request signal: the engine's own, composed with the consumer's. */
	#requestSignal(): AbortSignal {
		const external = this.#opts.signal;
		if (external === undefined) return this.#abortController.signal;
		return AbortSignal.any([this.#abortController.signal, external]);
	}

	/**
	 * `If-None-Match` / `If-Modified-Since` for a re-crawl — but only where the store
	 * actually holds a body: a `304` is worth asking for exactly when there is
	 * something to re-extract links from.
	 */
	async #conditionalHeaders(
		item: FrontierItem,
	): Promise<Record<string, string> | undefined> {
		if (!this.#opts.recrawl) return undefined;
		const state = await this.#visited.get(item.url);
		if (state?.hasBody !== true) return undefined;

		const headers: Record<string, string> = {};
		if (state.etag) headers["If-None-Match"] = state.etag;
		if (state.lastModified) headers["If-Modified-Since"] = state.lastModified;
		return Object.keys(headers).length > 0 ? headers : undefined;
	}

	async #recordVisited(
		item: FrontierItem,
		result: PageResult,
		fetchResult: FetchResult | undefined,
	): Promise<void> {
		const state: Parameters<VisitedStore["add"]>[1] = {
			crawledAt: Date.now(),
			attempts: result.attempts,
		};
		if (result.status > 0) state.status = result.status;
		if (result.contentHash !== undefined) state.contentHash = result.contentHash;
		const etag = fetchResult?.headers.get("etag");
		if (etag) state.etag = etag;
		const lastModified = fetchResult?.headers.get("last-modified");
		if (lastModified) state.lastModified = lastModified;
		await this.#visited.add(item.url, state);

		// Every URL the response passed through is marked visited too, so another
		// referrer pointing at a redirect hop (or at the destination) never re-fetches
		// the same bytes. These get the minimal record on purpose — they were never
		// frontier items of their own.
		if (fetchResult === undefined) return;
		const hops = [...fetchResult.redirects, fetchResult.finalUrl]
			.slice(0, MAX_RECORDED_REDIRECTS);
		for (const hop of hops) {
			const url = normalizeUrl(hop, undefined, this.#opts.normalize);
			if (url === null || url === item.url) continue;
			await this.#visited.add(url, {
				crawledAt: state.crawledAt,
				status: result.status,
			});
		}
	}

	// -------------------------------------------------------------------------------
	// document → links
	// -------------------------------------------------------------------------------

	/**
	 * Read one HTML document: title, meta-robots, canonical, and every link it points
	 * at — then decide what becomes work.
	 *
	 * The **two-pass rule** lives here. With a `beforeExtract` hook, `<head>`-derived
	 * data (title, canonical, next/prev, meta-refresh, meta-robots) still comes from the
	 * raw document while anchors and assets come from the narrowed HTML, and the
	 * effective base URL is computed once, from the raw document, and handed to both
	 * passes — `<base href>` lives in `<head>`, so a narrowed body pass left to its own
	 * devices would resolve every relative link against the wrong base.
	 */
	async #readDocument(
		result: PageResult,
		item: FrontierItem,
		html: string,
		fetchResult: FetchResult,
		header: RobotsDirectives,
		softDup: boolean,
	): Promise<void> {
		result.title = extractTitle(html);
		// `<meta name=robots>` merged with `X-Robots-Tag`, most-restrictive-wins
		const meta = parseMetaRobots(html);
		applyRobots(result, {
			noindex: header.noindex || meta.noindex,
			nofollow: header.nofollow || meta.nofollow,
			raw: [...header.raw, ...meta.raw],
		});

		let raw: RawLink[];
		if (this.#opts.beforeExtract === undefined) {
			raw = extractLinks(html, fetchResult.finalUrl, this.#extractAll);
		} else {
			const base = extractBaseHref(html, fetchResult.finalUrl);
			const ctx: PageContext = {
				crawlId: this.crawlId,
				requestId: result.requestId,
				item,
				fetchResult,
				stats: this.stats(),
			};

			let narrowed = html;
			try {
				const out = await this.#opts.beforeExtract(html, ctx);
				if (typeof out === "string") narrowed = out;
			} catch (e) {
				// narrowing is an optimization, not a correctness requirement
				if (!this.#warnedBeforeExtract) {
					this.#warnedBeforeExtract = true;
					this.#opts.logger?.warn(
						`[crawl] beforeExtract threw — falling back to the full ` +
							`document (warned once per crawl):`,
						e,
					);
				}
			}

			raw = [
				...extractLinks(html, base, this.#extractHead),
				...extractLinks(narrowed, base, this.#extractBody),
			];
		}

		await this.#processLinks(result, item, raw, softDup);
	}

	async #processLinks(
		result: PageResult,
		item: FrontierItem,
		raw: RawLink[],
		softDup: boolean,
	): Promise<void> {
		const from = item.url;
		const base = result.finalUrl;
		const scope = this.#opts.scope;
		const regionsPresent = raw.some((link) => link.region !== undefined);
		// a page that says `nofollow` says it about every link on it — recorded on each
		// edge, and reported under the same `"nofollow"` reason a `rel` would be
		const pageNofollow = result.robots?.nofollow === true;

		if (scope.followRegions.length > 0 && !regionsPresent && raw.length > 0) {
			if (!this.#warnedRegionFallback) {
				this.#warnedRegionFallback = true;
				this.#opts.logger?.warn(
					`[crawl] followRegions is set but ${from} has no landmark markup — ` +
						`region filtering does not apply to such pages (warned once ` +
						`per crawl)`,
				);
			}
		}

		for (const link of raw) {
			const record = await this.#processLink(link, {
				from,
				base,
				depth: item.depth,
				regionsPresent,
				pageNofollow,
				softDup,
			});
			result.links.push(record);
			if (this.#opts.collect.graph) this.#graph.push(record);
			if (record.followed === false && record.skipReason !== undefined) {
				this.#stats.recordSkip(record.skipReason);
				this.#emit("onLinkSkipped", (h) => h(record));
			}
			if (this.#opts.onLink !== undefined) this.#opts.onLink(record);

			if (
				record.rel === "canonical" && record.skipReason !== "bad-scheme" &&
				result.canonical === undefined
			) {
				result.canonical = record.to;
			}
		}
	}

	/** One edge: build its {@linkcode LinkRecord} and, if it survives, queue it. */
	async #processLink(
		link: RawLink,
		page: {
			from: string;
			base: string;
			depth: number;
			regionsPresent: boolean;
			pageNofollow: boolean;
			/** This page's body is a known soft-duplicate: it expands into nothing. */
			softDup: boolean;
		},
	): Promise<LinkRecord> {
		const resolved = link.url;
		const to = resolved === undefined
			? null
			: normalizeUrl(resolved, undefined, this.#opts.normalize);

		const record: LinkRecord = {
			from: page.from,
			// an unresolvable target is still an edge; recording what the markup
			// actually said is the only way "why was this not followed?" stays
			// answerable from the report
			to: to ?? resolved ?? link.href,
			rawHref: link.href,
			kind: to === null ? "external" : classifyLink(page.base, to, {
				subdomains: this.#opts.scope.subdomains,
			}),
			rel: link.rel,
			nofollow: link.nofollow || page.pageNofollow,
			followed: false,
		};
		if (link.region !== undefined) record.region = link.region;
		if (link.anchorText !== undefined) record.anchorText = link.anchorText;

		if (to === null) {
			record.skipReason = "bad-scheme";
			return record;
		}

		const verdict = evaluateScope(to, {
			...this.#scopeContext(),
			kind: record.kind,
			rel: record.rel,
			nofollow: record.nofollow,
			region: record.region,
			regionsPresent: page.regionsPresent,
		});
		if (!verdict.follow) {
			record.skipReason = verdict.reason;
			return record;
		}

		// `<link rel=canonical>` is recorded on every page; it becomes *work* only when
		// the consumer asked for that. "excluded" is the option-driven rejection reason
		// (the same one an `include` miss reports).
		if (record.rel === "canonical" && !this.#opts.followCanonical) {
			record.skipReason = "excluded";
			return record;
		}

		if (!await this.#robots!.isAllowed(to)) {
			record.skipReason = "robots-disallow";
			return record;
		}

		const depth = page.depth + 1;
		if (depth > this.#opts.maxDepth) {
			record.skipReason = "max-depth";
			return record;
		}

		// a soft-duplicate page is checked first, and without touching the per-path
		// counters: its links were never candidates, so letting them consume a path's
		// budget would make a soft-404 farm poison the paths it points at
		if (page.softDup || this.#isTrap(to)) {
			record.skipReason = "trap";
			return record;
		}

		if (!this.#opts.recrawl && await this.#visited.has(to)) {
			record.skipReason = "duplicate";
			return record;
		}

		if (this.#opts.shouldVisit !== undefined) {
			const allowed = await this.#opts.shouldVisit(to, {
				crawlId: this.crawlId,
				link: record,
				depth,
				referrer: page.from,
			});
			if (allowed === false) {
				record.skipReason = "user";
				return record;
			}
		}

		const outcome = await this.#enqueue({
			url: to,
			depth,
			discoveredVia: record.rel === "canonical" ? "canonical" : "link",
			referrer: page.from,
		});
		if (outcome === "pushed") record.followed = true;
		else record.skipReason = outcome;
		return record;
	}

	/**
	 * Both halves of {@linkcode "./traps.ts"}, in the order that keeps the counters
	 * honest: a URL whose *shape* is already a trap is never counted against its path.
	 *
	 * Deliberately not applied to seeds or to `add()`: those are instructions, not
	 * discoveries, and a crawl that refused the URL it was pointed at would be
	 * inexplicable.
	 */
	#isTrap(url: string): boolean {
		const parsed = new URL(url);
		if (detectUrlTrap(parsed, this.#opts.traps)) return true;
		return this.#traps.checkAndCount(parsed);
	}

	// -------------------------------------------------------------------------------
	// enqueueing
	// -------------------------------------------------------------------------------

	/** Turn the queued {@linkcode CrawlEngine.add} calls into frontier items. */
	async #drainManual(): Promise<void> {
		while (this.#manual.length > 0) {
			const pending = this.#manual;
			this.#manual = [];
			for (const entry of pending) {
				const reason = await this.#enqueueManual(entry);
				if (reason !== undefined) this.#stats.recordSkip(reason);
			}
		}
	}

	/** @returns the {@linkcode SkipReason} when the URL did not make it in. */
	async #enqueueManual(entry: ManualAdd): Promise<SkipReason | undefined> {
		const host = hostOf(entry.url);
		// a manual add is "subject to the same scope checks as any link" — including
		// include/pathPrefix, which seeds are exempt from
		const verdict = evaluateScope(entry.url, {
			...this.#scopeContext(),
			kind: isOnSeedSite(host, this.#scopeContext()) ? "internal" : "external",
			// a URL nobody found in a document has no region; that is exactly what the
			// whole-document fallback is for
			regionsPresent: false,
		});
		if (!verdict.follow) return verdict.reason;

		if (!await this.#robots!.isAllowed(entry.url)) return "robots-disallow";
		if (!this.#opts.recrawl && await this.#visited.has(entry.url)) return "duplicate";

		const outcome = await this.#enqueue({
			url: entry.url,
			depth: entry.depth,
			discoveredVia: "manual",
			meta: entry.meta,
		});
		return outcome === "pushed" ? undefined : outcome;
	}

	/**
	 * A seed bypasses `include`/`pathPrefix` — those narrow what a crawl *expands into*,
	 * and a seed is the instruction rather than a discovery. Everything else still
	 * applies, `exclude` included: a deny-list is never bypassable.
	 */
	async #enqueueSeed(url: string): Promise<void> {
		const ctx = this.#scopeContext();
		const verdict = evaluateScope(url, {
			...ctx,
			scope: { ...ctx.scope, include: [], pathPrefix: [] },
			kind: "internal",
			regionsPresent: false,
		});
		if (!verdict.follow) {
			this.#stats.recordSkip(verdict.reason);
			this.#opts.logger?.warn(`[crawl] seed rejected (${verdict.reason}): ${url}`);
			return;
		}

		if (!await this.#robots!.isAllowed(url)) {
			this.#stats.recordSkip("robots-disallow");
			this.#opts.logger?.warn(`[crawl] seed rejected (robots-disallow): ${url}`);
			return;
		}

		if (!this.#opts.recrawl && await this.#visited.has(url)) {
			this.#stats.recordSkip("duplicate");
			return;
		}

		const outcome = await this.#enqueue({ url, depth: 0, discoveredVia: "seed" });
		if (outcome !== "pushed") this.#stats.recordSkip(outcome);
	}

	async #enqueue(input: {
		url: string;
		depth: number;
		discoveredVia: DiscoveredVia;
		referrer?: string;
		meta?: Record<string, unknown>;
	}): Promise<EnqueueOutcome> {
		// the page budget is run state, not a property of this URL: past the cap nothing
		// new becomes work, while whatever is already queued stays queued — visible as
		// `stats.queued`, never rewritten into skips
		if (this.#pageCapReached()) return "max-pages";
		if (this.#queued >= this.#opts.maxQueued) return "queue-full";

		const item: FrontierItem = {
			url: input.url,
			host: hostOf(input.url),
			depth: input.depth,
			priority: input.depth,
			seq: this.#seq++,
			discoveredVia: input.discoveredVia,
		};
		if (input.referrer !== undefined) item.referrer = input.referrer;
		if (input.meta !== undefined) item.meta = input.meta;
		item.priority = this.#priorityOf(item);

		const pushed = await this.#frontier.push(item);
		if (!pushed) return "duplicate";
		this.#queued++;
		this.#signal();
		return "pushed";
	}

	/**
	 * The frontier sort key — lower pops first.
	 *
	 * A custom `priority` that throws or returns a non-number is *not* fatal: the item
	 * falls back to its depth and the crawl warns once. Killing a crawl over a sort key
	 * would be wildly disproportionate to what a sort key does.
	 */
	#priorityOf(item: FrontierItem): number {
		switch (this.#opts.strategy) {
			case "dfs":
				return -item.depth;
			case "priority": {
				try {
					const value = this.#opts.priority!(item);
					if (typeof value === "number" && !Number.isNaN(value)) return value;
				} catch (e) {
					if (!this.#warnedPriority) {
						this.#warnedPriority = true;
						this.#opts.logger?.warn(
							`[crawl] options.priority threw — falling back to depth ` +
								`ordering (warned once per crawl):`,
							e,
						);
					}
					return item.depth;
				}
				if (!this.#warnedPriority) {
					this.#warnedPriority = true;
					this.#opts.logger?.warn(
						`[crawl] options.priority did not return a number — falling ` +
							`back to depth ordering (warned once per crawl)`,
					);
				}
				return item.depth;
			}
			default:
				return item.depth;
		}
	}

	// -------------------------------------------------------------------------------
	// small helpers
	// -------------------------------------------------------------------------------

	#scopeContext(): ScopeContext {
		return {
			seedHosts: this.#seedHosts,
			scope: this.#opts.scope,
			kind: "internal",
			allowPrivateHosts: this.#opts.allowPrivateHosts,
		};
	}

	/**
	 * Was this URL admitted purely by `checkExternal`? Such an item is fetched once,
	 * body-less, and never expanded.
	 *
	 * Recomputed from the URL at claim time rather than carried on the frontier item:
	 * the answer is a pure function of the host and the scope options, and
	 * {@linkcode "../stores/types.ts".FrontierItem} has no room for engine flags.
	 */
	#isCheckOnly(url: string): boolean {
		const scope = this.#opts.scope;
		if (!scope.checkExternal || scope.allowExternal) return false;
		return !isOnSeedSite(hostOf(url), this.#scopeContext());
	}

	/**
	 * Seed/`add()` leniency: a bare `example.com` or `localhost:8080/x` gets `https://`.
	 *
	 * `normalizeUrl` refuses to invent a scheme on purpose — link extraction must never
	 * do that — so the leniency lives here, where the string came from a human rather
	 * than from markup. It only fires when the authority actually looks like one, so
	 * `mailto:a@b.com` stays rejected instead of silently becoming a crawl of `b.com`.
	 */
	#normalizeEntryUrl(input: string): string | null {
		if (typeof input !== "string") return null;
		const trimmed = input.trim();
		if (trimmed === "") return null;

		const direct = normalizeUrl(trimmed, undefined, this.#opts.normalize);
		if (direct !== null) return direct;

		if (/^https?:\/\//i.test(trimmed)) return null;
		const authority = trimmed.split(/[/?#]/, 1)[0];
		if (!/^[^\s/?#@:]+(:\d+)?$/.test(authority)) return null;
		return normalizeUrl(`https://${trimmed}`, undefined, this.#opts.normalize);
	}

	/** Resolve `options.fetcher` into a plain {@linkcode FetchFn}, building one if needed. */
	#resolveFetch(): void {
		const configured = this.#opts.fetcher;
		if (typeof configured === "function") {
			this.#fetch = configured;
			return;
		}
		if (configured !== undefined) {
			// a fetcher the consumer built is used as-is and never disposed by us
			this.#fetch = (req: FetchRequest) => configured.fetch(req);
			return;
		}
		this.#ownedFetcher = createFetcher({
			userAgent: this.#opts.userAgent,
			logger: this.#opts.logger,
		});
		this.#fetch = (req: FetchRequest) => this.#ownedFetcher!.fetch(req);
	}

	/**
	 * Build the robots gate.
	 *
	 * The transport default is the deviation worth knowing about: robots.txt is fetched
	 * with **the crawl's own transport** whenever the consumer injected one. Doc 02
	 * specifies a dedicated HTTP fetcher unconditionally, on the grounds that a
	 * browser-backed fetcher should not render robots.txt — but applied to an injected
	 * fetcher that rule routes robots.txt *around* a consumer's proxy or auth, where it
	 * 401s or times out and fails open to allow-all, silently. `robots.fetch` is the
	 * explicit override for the browser case; nothing overrides a silent failure.
	 */
	#resolveRobots(): void {
		const robots = this.#opts.robots;
		this.#robots = createRobotsGate({
			respect: robots.respect,
			userAgent: this.#opts.userAgent,
			crawlDelayCap: robots.crawlDelayCap,
			maxBytes: robots.maxBytes,
			fetch: robots.fetch ??
				(this.#opts.fetcher === undefined ? undefined : this.#fetch),
			...(this.#opts.logger === undefined ? {} : { logger: this.#opts.logger }),
			signal: this.#abortController.signal,
		});

		if (!robots.respect) {
			this.#opts.logger?.warn(
				`[crawl] robots.respect is false — this crawl ignores robots.txt`,
			);
		}
		if (robots.sitemaps) {
			this.#opts.logger?.warn(
				`[crawl] robots.sitemaps is not implemented yet — Sitemap: lines are ` +
					`parsed and readable, but nothing is seeded from them`,
			);
		}
	}

	async #disposeFetcher(): Promise<void> {
		const gate = this.#robots;
		this.#robots = undefined;
		await gate?.dispose();

		const owned = this.#ownedFetcher;
		this.#ownedFetcher = undefined;
		await owned?.dispose();
	}
}

/**
 * Record what a page said about itself — but only when it said something.
 *
 * `noindex` is recorded and never acted on: a crawler is not an indexer, and the
 * consumer that builds a sitemap is the one that cares. `nofollow` is what stops
 * expansion, in the scope pipeline.
 */
function applyRobots(result: PageResult, directives: RobotsDirectives): void {
	if (!directives.noindex && !directives.nofollow) return;
	result.robots = { noindex: directives.noindex, nofollow: directives.nofollow };
}

/** `new URL(url).hostname`, or `""` for anything that is not a URL. */
function hostOf(url: string): string {
	try {
		return new URL(url).hostname;
	} catch {
		return "";
	}
}

/** Map anything thrown into the `PageResult.error` shape. */
function toPageError(e: unknown): NonNullable<PageResult["error"]> {
	if (PageFetchError.is(e)) {
		const error: NonNullable<PageResult["error"]> = {
			kind: e.kind,
			message: e.message,
			retryable: e.retryable,
		};
		if (e.status !== undefined) error.status = e.status;
		return error;
	}
	return {
		kind: "internal",
		message: e instanceof Error ? e.message : String(e),
		retryable: false,
	};
}

/** SHA-256 of the raw response bytes, lowercase hex. */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0"))
		.join("");
}
