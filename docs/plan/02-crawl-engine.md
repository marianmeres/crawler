<!--
GENERATED ANALYSIS — @marianmeres/crawler implementation plan
Produced 2026-08-24 by multi-agent research -> adversarial verify -> synthesize.
Claims verified against ecosystem package working trees (page-fetcher v0.4.0, steve v3.0.0,
cron v3.2.0, clog v3.21.0). The crawler repo itself is a pre-first-commit scaffold.
Planning artifact; no code was changed.
-->

# Crawl Engine — Scope, Frontier, Politeness, Streaming API

> This doc owns the public TypeScript API of `@marianmeres/crawler` and the in-process
> crawl engine behind it: the worker pool, per-host politeness, scope/skip decisions,
> trap detection, the store interfaces, robots enforcement and events/stats. All
> transport is `@marianmeres/page-fetcher` — the engine never opens a socket itself,
> and it never retries a page (page-fetcher already retried the transport).
>
> The single most important takeaway: `createCrawler().run()` — an async iterator fed
> by a bounded channel — is the primary API. `crawl()` is a thin collect-everything
> convenience for small crawls. Backpressure, cancellation and budgets are engine
> concerns; dedup correctness belongs to `normalizeUrl` (doc 01) and the store
> contracts defined here.
>
> Headline recommendation: build the engine as a dispatcher loop over
> `FrontierStore.pop({ excludeHosts })` with a claim/ack lifecycle. That one contract
> is what lets doc 03 swap in a PG frontier with `FOR UPDATE SKIP LOCKED` without the
> engine changing a line. Get the pop contract right first; everything else layers on.

## Summary of work items

| # | Work item                                              | Value | Effort | Risk |
|---|--------------------------------------------------------|-------|--------|------|
| 1 | Public API surface: types, `crawl()`, `createCrawler()` | high  | M      | low  |
| 2 | Scope evaluation, `SkipReason`, private-host guard      | high  | M      | low  |
| 3 | `FrontierStore`/`VisitedStore` + memory implementations | high  | M      | med  |
| 4 | robots.txt enforcement gate + directives                | high  | M      | med  |
| 5 | Worker pool, politeness scheduling, streaming `run()`   | high  | L      | med  |
| 6 | Events, stats, safeEmit, id threading                   | med   | S      | low  |
| 7 | Budgets and `stoppedBy` semantics                       | med   | S      | low  |
| 8 | Trap detection                                          | med   | M      | med  |

Suggested implementation order: 1 → 2 → 3 → 5 (single-worker first) → 7 → 4 → 6 → 8,
mirroring the design sketch's order (tmp/crawler-DESIGN.md:440-453).

## Work items (detailed)

### 1. Public API surface: types, `crawl()`, `createCrawler()`

**What & why**
The whole public contract in one place: option/result/event types plus the two entry
points. The design sketch's §4 surface (tmp/crawler-DESIGN.md:83-182) is the base, with
the owner corrections applied: `logger` option (decision 7), `fetcher` accepting a
page-fetcher `Fetcher` or plain `FetchFn` with an owned-by-default HTTP fetcher
(decision 10), `maxTotalBytes` rename (decision 11), no `checkpoint()`/`checkpointEvery`
(decision 9), and stop/abort semantics from sketch §9 (tmp/crawler-DESIGN.md:319-333).

**Evidence / reuse**
- Sketch surface: `crawl`/`createCrawler`/`Crawler` (tmp/crawler-DESIGN.md:83-99),
  options (:109-137), results (:143-182).
- page-fetcher `FetchResult` — the source of most `PageResult` fields:
  `finalUrl` (page-fetcher/src/types.ts:160-161), `redirects` (:168-172),
  `requestId` (:173-174), `contentType` (:187-188), `charset` (:189-190),
  `size` (:191-192), `fromCache`/`notModified` (:193-196), `timing` (:129-146),
  `attempts` (:199-200), `meta` echo (:203-204).
- `Fetcher` interface with idempotent `dispose()` + `Symbol.asyncDispose`
  (page-fetcher/src/fetcher.ts:112-125); `createFetcher()` defaults to a single HTTP
  adapter (page-fetcher/src/fetcher.ts:171-176) and takes `userAgent` (:93-98).
- Browser fetching is injection-only — the browser adapter throws without a driver
  (page-fetcher/src/adapters/browser/browser-adapter.ts:241-246), which is why the
  sketch's "default: page-fetcher browser stack" was corrected to an HTTP default.
- `Logger` type re-export precedent (page-fetcher/src/types.ts:12-22); the shape itself
  is clog's `{debug, log, warn, error}` (clog/src/clog.ts:186-218).
- Error mapping: single `PageFetchError` with `.kind`/`.retryable`, matched via
  `PageFetchError.is()` never `instanceof` (page-fetcher/src/errors.ts:150-200, kinds
  :11-39).

**Spec**

```ts
// src/types.ts (public, re-exported from src/mod.ts)
import type { FetchFn, FetchResult, Fetcher, Logger } from "@marianmeres/page-fetcher";
export type { FetchFn, FetchResult, Fetcher, Logger }; // re-export like page-fetcher does

export function crawl(seeds: string | string[], options?: CrawlOptions): Promise<CrawlReport>;
export function createCrawler(options?: CrawlOptions): Crawler;

export interface Crawler {
	readonly crawlId: string; // crypto.randomUUID() at creation
	/** Enqueue manually (before or during run). discoveredVia: "manual". */
	add(urls: string | string[], init?: { depth?: number; meta?: Record<string, unknown> }): void;
	/** Async iterable of page results in completion order. Single-use: 2nd call throws. */
	run(seeds?: string | string[]): AsyncIterableIterator<PageResult>;
	/** Graceful: stop dispatching, drain in-flight, end the iterator. */
	stop(reason?: string): Promise<void>;
	/** Hard: abort in-flight fetches via AbortSignal, end asap. */
	abort(reason?: string): void;
	stats(): CrawlStats;
	/** Final report; undefined until the run ended. pages/graph per `collect`. */
	report(): CrawlReport | undefined;
	/** abort() + dispose of engine-owned fetchers. */
	[Symbol.asyncDispose](): Promise<void>;
}

export interface CrawlOptions {
	// transport
	fetcher?: Fetcher | FetchFn;   // default: engine-owned createFetcher() (HTTP adapter)
	userAgent?: string;            // default "marianmeres-crawler (+https://github.com/marianmeres/crawler)"
	// scheduling
	concurrency?: number;          // global in-flight cap, default 5
	perHostConcurrency?: number;   // default 2
	perHostDelay?: number;         // ms between dispatches to one host, default 0
	strategy?: "bfs" | "dfs" | "priority"; // default "bfs" (decision 13)
	priority?: (item: FrontierItem) => number; // lower pops first; required for "priority"
	maxQueued?: number;            // frontier bound, default 100_000
	// budgets (see item 7)
	maxDepth?: number;
	maxPages?: number;
	maxDuration?: number;          // ms
	maxTotalBytes?: number;        // cumulative response bytes (decision 11)
	// behavior
	scope?: ScopeOptions;          // item 2
	normalize?: NormalizeOptions;  // ./url, owned by doc 01
	extract?: ExtractOptions;      // ./extract, owned by doc 01
	robots?: RobotsOptions;        // item 4
	traps?: TrapOptions;           // item 8
	followCanonical?: boolean;     // default false — canonical recorded only (decision 13)
	recrawl?: boolean;             // default false; true = conditional re-fetch of visited URLs
	allowPrivateHosts?: boolean;   // default true (decision 16); false = SSRF guard on
	stores?: { frontier?: FrontierStore; visited?: VisitedStore }; // default: memory
	collect?: { pages?: boolean; graph?: boolean }; // what report() accumulates; see below
	// hooks
	beforeExtract?(html: string, ctx: PageContext): string | Promise<string>;
	shouldVisit?(url: string, ctx: LinkContext): boolean | Promise<boolean>;
	onPage?(res: PageResult, ctx: PageContext): unknown | Promise<unknown>;
	onLink?(link: LinkRecord): void;
	events?: CrawlEvents;          // item 6
	progressInterval?: number;     // onProgress throttle ms, default 500
	// infra
	logger?: Logger;               // default undefined = silent (decision 7)
	signal?: AbortSignal;          // external cancellation ≙ abort()
}

export type DiscoveredVia = "seed" | "link" | "sitemap" | "canonical" | "manual";
// sketch also had "redirect" (tmp/crawler-DESIGN.md:151); dropped — a redirect target is
// an attribute of the current item, never its own frontier item (decision 13).

export interface PageResult {
	crawlId: string;
	requestId: string;             // page-fetcher correlation id (types.ts:173-174)
	url: string;                   // normalized, as enqueued
	finalUrl: string;              // FetchResult.finalUrl
	redirects: string[];           // FetchResult.redirects ([] when none)
	status: number;
	ok: boolean;
	contentType?: string;
	charset?: string;
	depth: number;
	referrer?: string;             // first-discovery referrer
	discoveredVia: DiscoveredVia;
	attempts: number;              // FetchResult.attempts (retry layer's number)
	timing: { total: number; fetch: number; extract: number }; // fetch = FetchResult.timing.total
	size?: number;                 // bytes actually read
	fromCache: boolean;
	notModified: boolean;          // 304 path (incremental re-crawl)
	contentHash?: string;          // sha-256 hex of raw body bytes, when hasBody
	title?: string;                // via ./extract (doc 01)
	canonical?: string;            // normalized <link rel=canonical> target, when present
	robots?: { noindex?: boolean; nofollow?: boolean }; // meta robots + X-Robots-Tag
	links: LinkRecord[];           // every extracted link, followed or not
	error?: { kind: string; message: string; status?: number; retryable?: boolean };
	data?: unknown;                // whatever onPage returned
	meta?: Record<string, unknown>; // from add()/seed init
}

export interface LinkRecord {     // sketch shape kept (tmp/crawler-DESIGN.md:164-174)
	from: string;
	to: string;
	rawHref: string;
	kind: "internal" | "external";
	rel: "page" | "asset" | "canonical" | "alternate" | "next" | "prev" | "sitemap" | "iframe";
	nofollow: boolean;
	region?: LinkRegion;           // innermost landmark (doc 01 item 6); drives followRegions
	anchorText?: string;
	followed: boolean;
	skipReason?: SkipReason;
}

export interface LinkContext {    // arg of shouldVisit
	crawlId: string;
	link: LinkRecord;              // followed/skipReason not yet final
	depth: number;                 // depth the target would be enqueued at
	referrer: string;
}

export interface PageContext {    // arg of onPage and events.onPageDone
	crawlId: string;
	requestId: string;
	item: FrontierItem;
	/** Raw page-fetcher result: headers, text()/bytes(). Undefined on fetch failure.
	 * THE body access path — PageResult itself never holds the body (memory). */
	fetchResult?: FetchResult;
	stats: CrawlStats;
}

export interface CrawlReport {
	crawlId: string;
	pages: PageResult[];           // filled only when collect.pages
	graph: LinkRecord[];           // filled only when collect.graph
	stats: CrawlStats;
	stoppedBy: StoppedBy;          // item 7
	stoppedReason?: string;        // stop(reason)/abort(reason) passthrough
}
```

`crawl()` = `createCrawler({ ...options, collect: { pages: true, graph: true } })`,
`for await` everything, return `report()!`. Document: fine for small crawls; a 50k-page
crawl must use `run()` (sketch's own memory warning, tmp/crawler-DESIGN.md:75-78).
`collect` defaults for `createCrawler`: `{ pages: false, graph: false }` — streaming
consumers get stats + stoppedBy in `report()`, and persistence (doc 03) records
pages/links as they complete instead of in memory.

Fetcher resolution (decision 10): no `fetcher` → engine creates
`createFetcher({ userAgent, logger })` (HTTP adapter default,
page-fetcher/src/fetcher.ts:171-176) and disposes it in `run()`'s `finally`. A passed
`Fetcher` (object with `.fetch`) is used as-is and NEVER disposed; a plain function is
treated as `FetchFn` and called directly. Browser crawling = the consumer builds a
page-fetcher browser adapter with an injected driver and passes the resulting fetcher.

`recrawl: true`: a visited URL is enqueued anyway; at fetch time the engine sets
`If-None-Match`/`If-Modified-Since` request headers from `VisitedState.etag`/
`lastModified` (sketch §10 incremental re-crawl, tmp/crawler-DESIGN.md:367-372) — but
ONLY when `VisitedState.hasBody` is true (doc 03's gate): a 304 is only useful when a
stored body exists to re-extract links from. Memory stores keep no bodies and report
`hasBody: false`, so memory-mode re-crawls always refetch in full and rely on
`contentHash` comparison for change detection.
Note: manual conditional headers bypass page-fetcher's cache layer, so a hit arrives as
a raw `status: 304` with `FetchResult.notModified` false (that flag is the cache
layer's, page-fetcher/src/types.ts:195-196) — the engine sets
`PageResult.notModified = fetchResult.notModified || status === 304` and treats it as
success-unchanged.

**Files**
- `src/types.ts` (new — all public types), `src/mod.ts` (re-export types + `crawl` +
  `createCrawler`), `src/crawler.ts` (factory shells; engine in item 5).
- `deno.json` — exports map entry `"."` (the map change itself is doc 05's item).

**Value/Effort/Risk** — high/M/low; pure contract work, but every other doc consumes it,
so it lands first.

**Implementation notes**
- Type-only imports from `@marianmeres/page-fetcher` types; runtime import only of
  `createFetcher` (+ `PageFetchError` for `.is()`).
- Error mapping: `PageFetchError.is(e)` → `{ kind, message, status, retryable }`
  (page-fetcher/src/errors.ts:194-200); non-PageFetchError from hooks/extraction →
  `kind: "internal"`.
- `contentHash`: `crypto.subtle.digest("SHA-256", bytes)` hex over raw body bytes.
  (Sketch said "normalized text", tmp/crawler-DESIGN.md:155 — raw bytes chosen: cheaper,
  deterministic, and doc 03's `content_hash` change detection needs byte identity.)
- `timing.extract` measured around extractLinks + hooks; `timing.total` = fetch + extract.

### 2. Scope evaluation, `SkipReason`, private-host guard

**What & why**
Every extracted link gets a follow/skip verdict with a recorded reason — silent drops
make crawlers undebuggable (sketch §7, tmp/crawler-DESIGN.md:283-287). Pure, standalone,
unit-testable decision function; the private-host SSRF guard hooks in here
(decision 16).

**Evidence / reuse**
- `ScopeOptions` + `SkipReason` union: tmp/crawler-DESIGN.md:269-287.
- `isSameSite` from `./url` (doc 01; heuristic + injectable PSL per decision 12).
- `isPrivateHost` precedent — string-only check, documented DNS-rebinding caveat:
  collection/src/lib/utils/is-private-host.ts:1-14.

**Spec**

```ts
export interface ScopeOptions {   // sketch shape kept (tmp/crawler-DESIGN.md:270-281)
	subdomains?: "same-host" | "same-site" | "any"; // default "same-host"
	include?: (string | RegExp)[];
	exclude?: (string | RegExp)[];  // wins over include
	pathPrefix?: string | string[];
	allowExternal?: boolean;        // default false — record, don't visit
	checkExternal?: boolean;        // default false — visit once, depth-capped, retainBody:false
	followNofollow?: boolean;       // default false
	followRegions?: LinkRegion[];   // default [] = off; see "region scoping" below
	maxUrlLength?: number;          // default 2048
}

export type SkipReason =
	| "out-of-scope" | "excluded" | "duplicate" | "max-depth" | "max-pages"
	| "nofollow" | "robots-disallow" | "bad-scheme" | "unsupported-type"
	| "trap" | "too-long" | "private-host" | "queue-full" | "out-of-region" | "user";
// = sketch union (tmp/crawler-DESIGN.md:286-287) + "private-host" (decision 16 guard)
//   + "queue-full" (maxQueued overflow; see item 5)
//   + "out-of-region" (followRegions; the sketch anticipated this as a nice-to-have at
//     tmp/crawler-DESIGN.md:256-258 — promoted to v1, see "region scoping" below).

// src/engine/scope.ts — pure; engine supplies the async bits (robots, visited, shouldVisit)
export type ScopeVerdict = { follow: true } | { follow: false; reason: SkipReason };
export function evaluateScope(to: URL, ctx: {
	seedHosts: string[]; scope: Required<ScopeOptions>; kind: "internal" | "external";
	/** Innermost landmark of the link under evaluation; undefined when the markup had
	 *  none. Ignored unless `scope.followRegions` is non-empty. */
	region?: LinkRegion;
	/** False when the whole document produced no regioned links — lets the pure
	 *  function honor the document-level fallback without knowing about documents.
	 *  The engine computes it once per page and passes the same value for every link. */
	regionsPresent?: boolean;
}): ScopeVerdict;
```

Engine-side check order (first hit wins, spec'd so tests can pin it):
1. `bad-scheme` / `too-long` — `normalizeUrl` returned null (doc 01) or > maxUrlLength.
2. `private-host` — `!allowPrivateHosts && isPrivateHost(host)`.
3. `out-of-scope` — kind external without allowExternal/checkExternal; or subdomain rule
   fails (`isSameSite` from `./url`); or pathPrefix miss.
4. `excluded` / include-miss → `excluded` (document: include-miss reports `excluded`).
5. `nofollow` — link rel nofollow (unless followNofollow), or the SOURCE page had
   meta-robots/X-Robots-Tag nofollow (item 4; same reason, documented).
6. `out-of-region` — `followRegions` non-empty and `link.region` not in it. Cheap,
   pure, synchronous — placed here (with the other markup-derived checks, before the
   awaited robots gate) so a nav-heavy page short-circuits most of its links.
   **Subject to the whole-document fallback below.**
7. `unsupported-type` — extension deny-list for obvious binaries
   (images/archives/media/fonts) when the link is rel "page"; rel "asset" links are
   only fetched under checkExternal/link-check recipes, with `retainBody: false`
   (page-fetcher/src/types.ts:103-108) and never parsed for links.
8. `robots-disallow` — item 4 gate (async, awaited during link processing).
9. `max-depth` / `max-pages` — budget state (item 7).
10. `trap` — item 8.
11. `duplicate` — visited, or frontier `push()` returned false (item 3).
12. `user` — `shouldVisit` returned false (called last, only for links that passed
    everything above; may be async).

Every `follow: false` produces: `LinkRecord.followed = false` + `skipReason`,
`onLink` + `events.onLinkSkipped`, `stats.skippedByReason[reason]++`. Never a
pseudo-PageResult (decision 13; sketch §13.5, tmp/crawler-DESIGN.md:435-436).

**Region scoping (`scope.followRegions`)** — "crawl the content, ignore the chrome".
Motivating case: a docs/content site where only in-`<main>` links should be traversed,
so header/nav/footer links are recorded but never followed. This is not a niche filter —
every page links to every other page through its nav, so following only content links
collapses the frontier and yields the actual *content* graph instead of the *navigation*
graph.

Three rules, all of which need tests:

1. **Filtering happens in scope, never in extraction.** `extractLinks` always returns
   every link with its `region`; only the follow decision consults `followRegions`. A
   chrome link therefore still lands in `report.graph` with
   `followed: false, skipReason: "out-of-region"`, so link-checking a footer still
   works. Filtering at extraction time would silently delete graph data — exactly the
   "silent drops make crawlers impossible to debug" failure the SkipReason union exists
   to prevent.
2. **Innermost-wins, so `["main", "article"]` is the documented value.** `region` is the
   innermost landmark (doc 01 item 6 step 9), so a link in `<main><article><p>` reports
   `"article"`. `["main"]` alone would skip the body of a typical blog/docs page. The
   JSDoc must say this; a user reaching for `["main"]` and silently getting a one-page
   crawl is the most likely support question this feature will generate.
3. **Whole-document fallback.** If a fetched document yields **no** regioned links at
   all (`links.every(l => !l.region)` — div-soup markup with no landmarks), region
   filtering does not apply to that document and every link is evaluated normally.
   Without this, one non-semantic page silently dead-ends the crawl. Log
   `logger?.warn` **once per crawl** (a latched flag, not per page) naming the first URL
   that triggered it, and count it in stats so it shows up in a report rather than only
   in logs. The check is per *document*, not per link: a page whose links all sit in
   `<footer>` has regioned links, so the fallback correctly does not fire and those
   links are correctly skipped.

**`beforeExtract` — the div-soup escape hatch.** Region scoping only sees element names,
so a site whose content is `<div class="main">` has no landmarks to match and falls back
to following everything. That is the common case, not the exotic one, so the engine gives
the consumer a seam to narrow the HTML before body links are discovered — typically by
handing it to a content extractor (`@marianmeres/html-extract`, a sibling package the
crawler does **not** depend on):

```ts
beforeExtract: (html) => extractMainContent(html)?.html ?? html
```

Kept a hook rather than a dependency because the crawler's core jobs — link checking,
sitemap generation, graph building — need no DOM at all, and JSR has no
`optionalDependencies`, so a direct dependency would tax every one of those users with a
parser they never call. The `?? html` fallback is not decoration: extraction failing must
degrade to a full-document crawl, never to a dead end.

Extraction becomes **two passes** when the hook is set, and this is the part an
implementation will get wrong if it is not spelled out:

| Pass | Input | Base | Sources enabled |
|------|-------|------|-----------------|
| head | raw HTML | `extractBaseHref(rawHtml, finalUrl)` | `canonical`, `nextPrev`, `alternate`, `metaRefresh` + `extractTitle` + `parseMetaRobots` |
| body | `beforeExtract(html)` result | **the same value** — passed in, never re-derived | `anchors`, `assets`, `srcset` |

Narrowing to `<main>` removes `<head>`, so title, canonical, next/prev and meta-robots
**must** come from the raw document or they silently vanish. Without the hook there is
exactly one pass over the raw HTML, as today — do not pay for two passes by default.

**The `<base href>` trap — verified against a real narrowing, not assumed.** `<base>`
lives in `<head>`, so it is *gone* from the narrowed HTML (confirmed by probing
`@marianmeres/html-extract@0.3.0`: `extractMainContent()` returns the content subtree
with hrefs exactly as written and no `<base>`). If the body pass is handed `finalUrl` and
left to re-derive its own base, every relative link on a `<base>`-bearing page resolves
against the wrong origin path — silently, and for every URL on the page. So the engine
computes the effective base **once, from the raw document**, and passes it as the
`baseUrl` argument of *both* `extractLinks` calls. Under the hook, `extractLinks` must
never be allowed to fall back to its own `<base>` lookup for the body pass.

Two properties of the narrowed HTML the engine can rely on (same probe): hrefs are
preserved verbatim — relative stays relative, so `rawHref` and the crawler's own
resolution are unaffected — and `<nav>`, `<header>`, `<footer>` and `<aside>` subtrees
are already dropped by the extractor, so chrome filtering happens even where
`followRegions` had nothing to match.

Three further rules:

- **Raw bytes are untouched.** `contentHash`, `PageResult.size`, `ctx.fetchResult` and
  doc 03's body archive all keep the full response. The hook narrows *discovery*, not
  storage — persisting a narrowed body would break re-extraction, which is the entire
  point of archiving bodies.
- **A throw is not fatal.** Fall back to the raw HTML, `logger?.warn` once per crawl
  (latched, like the region fallback), and keep crawling.
- **Composes with `followRegions`.** Narrowing runs first; region filtering then applies
  to whatever landmarks survive — usually none, so the whole-document fallback makes it a
  no-op. Using both is therefore safe and needs no special-casing.

**Files**
- `src/engine/scope.ts`, `src/engine/private-host.ts` (verbatim-ish copy of
  collection's `isPrivateHost`, collection/src/lib/utils/is-private-host.ts:14),
  `tests/scope.test.ts`.

**Value/Effort/Risk** — high/M/low; pure logic, exhaustively testable without I/O.

**Implementation notes**
- Copy the collection file's JSDoc caveat verbatim in spirit: string-only check, no
  DNS-rebinding protection (collection/src/lib/utils/is-private-host.ts:9-12); README
  documents `allowPrivateHosts: false` as best-effort.
- `checkExternal` externals: enqueued once with `retainBody: false`, depth = current+1,
  never expanded (no extraction). Deviation from the sketch's "at depth 0" comment
  (tmp/crawler-DESIGN.md:276): depth stays link-distance everywhere; externals are never
  expanded, so the value is purely informational.

### 3. `FrontierStore`/`VisitedStore` interfaces + memory implementations

**What & why**
The pluggable persistence seam. The interfaces must be shaped so doc 03's PG stores can
implement them with `FOR UPDATE SKIP LOCKED` claims and per-item ready-times without
engine changes — which forces a claim/ack lifecycle into `pop()`, not a naive dequeue.

**Evidence / reuse**
- Sketch store sketch (tmp/crawler-DESIGN.md:337-359) — extended: its
  `pop(filter?: { hostsAtCapacity })` had no claim/ack lifecycle, which a SKIP LOCKED
  implementation and crash-resume both need.
- PG frontier table carries `status pending|in_flight|done` + `ready_at` (backbone table
  set; column detail owned by doc 03).

**Spec**

```ts
// src/stores/types.ts
export interface FrontierItem {
	url: string;                    // normalized — the dedup key
	host: string;
	depth: number;
	priority: number;               // lower pops first (see strategy mapping below)
	seq: number;                    // engine-assigned monotonic tie-breaker
	referrer?: string;
	discoveredVia: DiscoveredVia;
	readyAt?: number;               // epoch ms; ineligible before this instant
	meta?: Record<string, unknown>;
}

export interface FrontierStore {
	/** Insert unless this url was ever pushed in this run (any status).
	 * Returns true iff inserted — false IS the "duplicate" signal (PG:
	 * INSERT ... ON CONFLICT DO NOTHING, atomically). */
	push(item: FrontierItem): Promise<boolean>;
	/** CLAIM the next eligible item and atomically mark it in-flight.
	 * Eligible: status pending AND (readyAt ?? 0) <= now AND host ∉ excludeHosts.
	 * Order: (priority ASC, seq ASC). Undefined = nothing eligible right now
	 * (which is NOT "frontier empty" — check size()).
	 * PG contract: one SELECT ... FOR UPDATE SKIP LOCKED + UPDATE status. */
	pop(filter?: { excludeHosts?: readonly string[]; now?: number }): Promise<FrontierItem | undefined>;
	/** Terminal ack of a claimed item (fetched, or skipped post-claim). */
	ack(url: string): Promise<void>;
	/** Return a claimed item to pending, optionally not before readyAt. */
	release(url: string, readyAt?: number): Promise<void>;
	/** Pending count (in-flight excluded). */
	size(): Promise<number>;
}

export interface VisitedStore {   // sketch shape (tmp/crawler-DESIGN.md:345-350)
	has(url: string): Promise<boolean>;
	add(url: string, state: VisitedState): Promise<void>;  // upsert
	get(url: string): Promise<VisitedState | undefined>;
	count(): Promise<number>;
}

export interface VisitedState {   // sketch shape (tmp/crawler-DESIGN.md:352-359)
	status?: number;
	contentHash?: string;
	etag?: string;                  // → If-None-Match on recrawl (item 1)
	lastModified?: string;          // → If-Modified-Since on recrawl
	crawledAt?: number;
	attempts?: number;
	/** True when the backing store holds the body for this URL (PG archive). Gates
	 * conditional-header seeding on recrawl (item 1) — a 304 needs a stored body to
	 * re-extract links from. Memory stores always report false/undefined. */
	hasBody?: boolean;
}
```

Lifecycle rules the engine guarantees (and doc 03 may rely on):
- Exactly one of `ack`/`release` per successful `pop`, from the same process.
- A URL is added to `VisitedStore` at COMPLETION (success or terminal error), plus each
  redirect intermediate URL (decision 13) with a minimal `{ crawledAt, status }` state.
- Dedup = `visited.has(url)` (checked pre-push) OR `push() === false`. Single-process
  engine serializes link processing per page, so this pair is race-free here; the PG
  store's `push` is atomic anyway.
- The engine never calls `pop` concurrently with itself (single dispatcher loop).
- Politeness is engine-side state; `excludeHosts` is how it reaches the store. Item-level
  `readyAt` exists for `release()` deferrals and future multi-process schedulers —
  designed so distribution is not precluded (sketch non-goal, tmp/crawler-DESIGN.md:34).

Strategy → priority mapping (engine, not store): `bfs` → `priority = depth`;
`dfs` → `priority = -depth`; `priority` → user function (item 1). Ties broken by `seq`,
so BFS is strict FIFO within a depth. Default BFS makes depth = nearest-seed distance
(decision 13; sketch §13.3, tmp/crawler-DESIGN.md:431-432).

Memory implementations: `createMemoryFrontier()`, `createMemoryVisited()` — the
defaults when `options.stores` is absent (decision 1).

**Files**
- `src/stores/types.ts`, `src/stores/memory-frontier.ts`, `src/stores/memory-visited.ts`,
  `src/stores/mod.ts` (exports interfaces + factories), `tests/stores.test.ts`.

**Value/Effort/Risk** — high/M/med; the risk is contract mismatch with doc 03's PG
implementation — mitigate by treating the lifecycle rules above as normative.

**Implementation notes**
- Memory frontier: `Map<host, MinHeap<(priority, seq)>>` + a `Set<string>` of all pushed
  urls + `Map<url, FrontierItem>` for in-flight. `pop` scans eligible hosts picking the
  global min head — O(#hosts), fine (same-host crawls dominate; a many-host crawl is a
  PG crawl). `readyAt` respected by treating a head item with future `readyAt` as
  ineligible.
- `size()` is O(1) via a counter. Memory visited: `Map<string, VisitedState>`.
- Do NOT add snapshot/checkpoint methods (decision 9 dropped them; resume is a property
  of the PG stores, doc 03).

### 4. robots.txt enforcement gate + directives

**What & why**
Per-origin robots rules gate every enqueue; `Crawl-delay` feeds the politeness
scheduler; meta-robots and `X-Robots-Tag` gate FOLLOWING a fetched page's links.
Parsing (`parseRobotsTxt`, `parseMetaRobots`, `parseXRobotsTag`) is doc 01's; this item
is the engine-side cache + enforcement + fetch policy (decision 14).

**Evidence / reuse**
- Sketch §8 (tmp/crawler-DESIGN.md:303-316).
- Fetch policy: page-fetcher HTTP adapter takes adapter-level `maxBytes` and
  `allowContentTypes` (page-fetcher/src/adapters/http.ts:75-88) — these are NOT
  per-request options, so robots needs its own small fetcher instance rather than a
  flag on the main one.
- Default allow-list for reference (page-fetcher/src/content-type.ts:18-27).
- `onUnsupportedType: "skip-body"` policy (page-fetcher/src/adapters/http.ts:87-88).

**Spec**

```ts
export interface RobotsOptions {
	respect?: boolean;        // default true; explicit false logs ONE warning (decision 14)
	sitemaps?: boolean;       // default false — opt-in: seed frontier from Sitemap: lines
	crawlDelayCap?: number;   // ms cap on honored Crawl-delay, default 30_000
	maxBytes?: number;        // robots.txt fetch cap, default 512_000
	fetch?: FetchFn;          // transport override (auth/proxy setups); default below
}
```

Engine-owned robots fetcher (created lazily, disposed by the engine): a dedicated
`createFetcher({ adapters: createHttpAdapter({ maxBytes, allowContentTypes:
["text/plain"], onUnsupportedType: "skip-body" }), userAgent, logger })` — always the
HTTP adapter, even when the main fetcher is browser-backed. A robots.txt served as
text/html (SPA fallback page) thus arrives body-less → treated as "no rules".

`RobotsGate` (src/engine/robots-gate.ts, internal):

```ts
interface RobotsGate {
	/** Resolves rules for the url's origin, fetching+caching on first miss.
	 * Concurrent misses for one origin share a single in-flight promise. */
	isAllowed(url: string): Promise<boolean>;
	crawlDelayMs(host: string): number;      // 0 when unknown/none; capped
	sitemapUrls(origin: string): string[];   // from cached rules
}
```

Failure semantics (decision 14, resolving sketch's "pick one",
tmp/crawler-DESIGN.md:305-307): fetch error or any 4xx → allow-all; 5xx → disallow-all,
with one `logger?.warn` per origin. Cache is per-run, no TTL (document: a multi-day
crawl re-reads robots only across runs).

Post-fetch directives: `X-Robots-Tag` header (UA-scoped and bare) via doc 01's
`parseXRobotsTag`, meta robots via `parseMetaRobots` →
`PageResult.robots = { noindex?, nofollow? }`.
`nofollow`/`none` → every extracted link recorded with `followed: false,
skipReason: "nofollow"`. `noindex` is recorded only — a crawler is not an indexer;
consumers (sitemap recipe) filter on it.

Seeding from sitemaps (`robots.sitemaps: true`): after first rules fetch for a seed
origin, sitemap URLs are fetched (main fetcher), parsed via doc 01's `parseSitemap`,
and enqueued depth 1, `discoveredVia: "sitemap"`, subject to normal scope checks.

**Files**
- `src/engine/robots-gate.ts`, `tests/robots-gate.test.ts` (injected `fetch` stub —
  no sockets).

**Value/Effort/Risk** — high/M/med; risk is directive-parsing edge cases, contained by
doc 01 owning the parser and this item owning only cache/policy.

**Implementation notes**
- `robots.respect: false` (this doc's spelling of decision 14's `respectRobots` opt-out):
  `isAllowed` returns true always, `crawlDelayMs` 0; warn once at `run()` start.
- The gate is awaited inside worker link-processing (async context already), so
  enqueue-time checks are exact — no claim-time recheck needed.

### 5. Worker pool, politeness scheduling, streaming `run()`

**What & why**
The engine proper: a dispatcher loop + N workers over the frontier, enforcing global
AND per-host concurrency simultaneously, per-host ready-times of
`max(perHostDelay, robotsCrawlDelay)`, bounded-channel backpressure into the `run()`
iterator, and cancellation into in-flight fetches. page-fetcher has no scheduling of
its own — "it knows nothing about links, recursion, sites or crawling — a crawler sits
on top of it" (page-fetcher/README.md:10-12); its src wires only
cache/breaker/events/guards/retry/timeout/routing layers
(page-fetcher/src/fetcher.ts:10-24), so all politeness lives here.

**Evidence / reuse**
- Sketch §9 requirements (tmp/crawler-DESIGN.md:319-333): simultaneous caps, delay
  combination, ready-time host scheduling without busy-waiting, bounded channel,
  cancellation, SIGINT in examples only.
- Cancellation: `FetchRequest.signal` propagates into platform fetch/browser/retry
  sleeps (page-fetcher/src/types.ts:86-87); abort surfaces as `PageFetchError`
  `kind: "aborted"` (page-fetcher/src/errors.ts:18-19).
- Retry layering: page-fetcher retries transport per request — retry layer wired by
  default in `createFetcher` (page-fetcher/src/fetcher.ts:230-235). The engine NEVER
  re-enqueues a failed page (backbone layering rule); a terminal fetch error is a
  `PageResult` with `error`, acked and marked visited.
- Request metadata: engine sets `meta: { crawlId, depth, referrer }` on every request —
  echoed back, and page-fetcher's JSDoc anticipates exactly this
  (page-fetcher/src/types.ts:118-119).

**Spec**

Dispatcher state per host: `{ inFlight: number, nextReadyAt: number }` in a
`Map<host, HostState>`. Loop invariants:

1. Blocked when `globalInFlight >= concurrency` → await a completion signal.
2. `excludeHosts` = hosts with `inFlight >= perHostConcurrency` OR `nextReadyAt > now`.
3. `item = await frontier.pop({ excludeHosts })`.
   - Item → dispatch: `host.inFlight++`, `host.nextReadyAt = now +
     max(perHostDelay, robotsGate.crawlDelayMs(host))` (delay measured from dispatch),
     start worker.
   - Undefined + `globalInFlight === 0` + `await frontier.size() === 0` → crawl
     complete.
   - Undefined otherwise → sleep until `min(earliest nextReadyAt among delay-blocked
     hosts, next completion)` via ONE `setTimeout` raced against a completion-resolved
     promise. No polling loops (sketch: avoid busy-waiting,
     tmp/crawler-DESIGN.md:324-325).

Worker (per claimed item): compose `signal = AbortSignal.any([options.signal,
internalController.signal])`; fetch with `{ url, signal, retainBody, headers
(conditional, per recrawl), meta: { crawlId, depth, referrer } }`; on HTML result with
body → extract links (doc 01, two-pass when `beforeExtract` is set — see below), run
items 2/4/8 verdicts per link, push follows; run
`onPage`; build `PageResult`; `await channel.push(result)` (parks when the consumer is
slow — this plus invariant 1 is the whole backpressure story); `frontier.ack(url)`;
`visited.add(...)`; decrement counters; signal the dispatcher.

Bounded channel (src/engine/channel.ts, internal):

```ts
class Channel<T> {
	constructor(capacity: number);          // default: concurrency * 2
	push(v: T): Promise<void>;              // resolves when accepted; parks when full
	next(): Promise<IteratorResult<T>>;
	close(): void;                          // next() drains buffer, then { done: true }
	fail(err: unknown): void;               // pending next() rejects
}
```

`run(seeds?)` semantics:
- Single-use; normalizes seeds, checks robots/scope, pushes depth 0
  `discoveredVia: "seed"`, then yields from the channel until close.
- Consumer `break` (iterator `return()`) ≙ `stop("consumer-break")`: dispatch stops,
  in-flight drain, their results are discarded (not delivered, still recorded to
  stats/visited and, in PG mode, persisted by doc 03's sink).
- `finally`: dispose engine-owned fetchers only (main + robots; decision 10), fire
  `onEnd(report())`.

`stop(reason)`: stop dispatching, drain in-flight to completion, close channel, resolve
after finalization. `abort(reason)`: `internalController.abort()` → in-flight reject
`kind: "aborted"`; claimed items are `release()`d back to pending (so a PG run resumes
them); channel closed after workers settle. `options.signal` firing takes the `abort()`
path. `maxQueued` overflow: a link that would exceed it is skipped with
`skipReason: "queue-full"` (recorded like any skip — never silent).

**Files**
- `src/crawler.ts` (engine orchestration), `src/engine/dispatcher.ts`,
  `src/engine/channel.ts`, `tests/engine.test.ts` (stub `FetchFn` — zero sockets;
  politeness timing tests with injected `now`).

**Value/Effort/Risk** — high/L/med; the concurrency/timing logic is the hardest code in
the package — mitigated by injectable clock + stub fetchers and by building the
single-worker loop first (sketch order, tmp/crawler-DESIGN.md:447-448).

**Implementation notes**
- Workers are plain promises tracked in a Set — no recursion (sketch,
  tmp/crawler-DESIGN.md:75-78).
- `PageFetchError.is()` for error classification, never `instanceof`
  (page-fetcher/src/errors.ts:189-200).
- Circuit breaker is page-fetcher's, off by default; the many-host recipe should enable
  it on the injected fetcher (page-fetcher/src/fetcher.ts:67-75). Engine treats
  `kind: "circuit-open"` as a terminal page error like any other.
- SIGINT handling belongs in examples, not the library (tmp/crawler-DESIGN.md:331-333).

### 6. Events, stats, safeEmit, id threading

**What & why**
Observable crawls: plain-callback events with a safeEmit wrapper (a throwing handler
never breaks the crawl), throttled `onProgress` for long runs, and correlation ids
threaded end to end — `crawlId` per run, page-fetcher's `requestId` per page.

**Evidence / reuse**
- Sketch §11 (tmp/crawler-DESIGN.md:377-398).
- safeEmit precedent: page-fetcher event handlers are fire-and-forget and "a throwing
  handler never affects the fetch outcome" (page-fetcher/src/types.ts:252-256).
- `requestId`: auto-generated `crypto.randomUUID()` stamped by the first layer that
  sees it missing (page-fetcher/src/internal.ts:21-25), always present on results
  (page-fetcher/src/types.ts:173-174) — the engine reads it off `FetchResult`, it does
  not invent its own per-page id.

**Spec**

```ts
export interface CrawlEvents {    // sketch shape minus onCheckpoint (decision 9)
	onStart?(info: { crawlId: string; seeds: string[]; options: Readonly<CrawlOptions> }): void;
	onPageStart?(item: FrontierItem): void;
	/** ctx.fetchResult gives body access — the persistence sink (doc 03) consumes this. */
	onPageDone?(res: PageResult, ctx: PageContext): void;
	onPageError?(err: unknown, item: FrontierItem): void;  // also produces onPageDone with res.error
	onLinkSkipped?(link: LinkRecord): void;
	onProgress?(stats: CrawlStats): void;   // throttled: progressInterval, default 500ms
	onEnd?(report: CrawlReport): void;
}

export interface CrawlStats {     // sketch shape + crawlId + skippedByReason
	crawlId: string;
	queued: number; inFlight: number;
	done: number; failed: number; skipped: number;
	bytes: number;                  // cumulative FetchResult.size — feeds maxTotalBytes
	startedAt: number; elapsed: number;
	pagesPerSecond: number;
	byStatus: Record<number, number>;
	byHost?: Record<string, number>;
	skippedByReason: Partial<Record<SkipReason, number>>;
	eta?: number;                   // best-effort; only meaningful with maxPages
}
```

`safeEmit(name, fn)`: try/catch, `logger?.warn("[crawl] event handler ${name} threw:",
e)`, never rethrow, return value ignored (async handlers are not awaited — document).
Every event call site goes through it; `onPage`/`shouldVisit`/`onLink` HOOKS are NOT
safeEmit-wrapped — a throwing hook fails that page (recorded as its `error`), because
hooks produce data, events observe it.

`onProgress`: interval timer while running + one final emit before `onEnd`; `stats()`
returns the same snapshot on demand (cheap counter reads, `byStatus`/`byHost` copied).
`options` in `onStart` is the post-defaults resolved snapshot.

**Files**
- `src/engine/stats.ts` (counters + snapshot + safeEmit + progress timer),
  `tests/events.test.ts`.

**Value/Effort/Risk** — med/S/low.

**Implementation notes**
- The job wiring (doc 04) consumes `onProgress` to update the crawl-run row's stats
  JSONB — keep the snapshot JSON-serializable (no Headers, no functions).
- `byHost` capped (e.g. top 100 hosts) to keep snapshots bounded on many-host crawls.

### 7. Budgets and `stoppedBy` semantics

**What & why**
Deterministic, documented termination. Budgets are checked in exactly one place each,
and the report says which one fired.

**Evidence / reuse**
- Sketch budgets + stoppedBy (tmp/crawler-DESIGN.md:117-121, 181), `maxTotalBytes`
  rename per decision 11; `bytes` sums `FetchResult.size`
  (page-fetcher/src/types.ts:191-192).
- Decision 13 adoptions (sketch §13, tmp/crawler-DESIGN.md:424-437).

**Spec**

```ts
export type StoppedBy =
	| "completed" | "maxPages" | "maxDuration" | "maxTotalBytes" | "stop" | "abort";
```

Deviation from sketch §4 (tmp/crawler-DESIGN.md:181): `maxDepth` is NOT a `stoppedBy`
value — it prunes expansion (`skipReason: "max-depth"` on deeper links) and the crawl
then completes normally (`stoppedBy: "completed"`, with the pruning visible in
`stats.skippedByReason`). A budget that stops must stop the RUN; depth never does.

- `maxPages`: counts completed fetches (done + failed). Reached → graceful-stop path.
  Links discovered after the cap record `skipReason: "max-pages"`; already-queued items
  simply remain unfetched (visible as `stats.queued`, not converted to skips).
- `maxDuration`: one timer armed at `run()` start → graceful-stop path (in-flight
  drains; dispatch stops). Not a hard abort — page-fetcher's own `deadline` exists for
  per-request hard limits.
- `maxTotalBytes`: checked after each completion against `stats.bytes` → graceful stop.
  Document: stop-after-crossing, in-flight responses may overshoot by up to
  `concurrency × page-fetcher maxBytes`.
- Precedence: first budget crossed wins and is latched; `abort` overrides everything;
  `stop` overrides budgets only if it latched first.

Decision 13 adoptions, spelled once here, engine-wide:
- Canonical: recorded (`PageResult.canonical` + rel "canonical" LinkRecord);
  `followCanonical: true` additionally enqueues it (`discoveredVia: "canonical"`,
  depth + 1, normal scope checks). Never replaces the crawled URL.
- Redirects: attribute of the current item (`finalUrl`, `redirects[]`); each
  intermediate URL marked visited so another referrer never re-fetches it.
- Depth: assigned at first enqueue; BFS default ⇒ nearest-seed distance. Under
  dfs/priority it is first-discovery distance — documented, no re-parenting.
- Skips: events + graph records only, never pseudo-results.

**Files**
- Enforcement lives inside `src/crawler.ts`/`src/engine/dispatcher.ts` (no new files);
  `tests/budgets.test.ts`.

**Value/Effort/Risk** — med/S/low; pure bookkeeping once item 5 exists.

### 8. Trap detection

**What & why**
Real sites contain infinite URL spaces (calendars, faceted search, path loops); without
caps the crawl never ends (sketch §7, "required", tmp/crawler-DESIGN.md:289-299).

**Evidence / reuse**
- Sketch trap list + defaults (tmp/crawler-DESIGN.md:293-299).
- Soft-404 detection consumes `contentHash` (item 1).

**Spec**

```ts
export interface TrapOptions {    // each cap disabled by Infinity; 0 is invalid
	maxSegmentRepeat?: number;      // default 3 — /a/b/a/b/a/b…
	maxPathDepth?: number;          // default 20 path segments (independent of crawl depth)
	maxQueryParams?: number;        // default 32 distinct params per URL
	maxUrlsPerPath?: number;        // default 200 distinct URLs per (host, pathname)
	softDupThreshold?: number;      // default 10 pages sharing one contentHash
}

// src/engine/traps.ts
/** Pure URL-shape checks: segment repeats, path depth, query-param count. */
export function detectUrlTrap(url: URL, opts: Required<TrapOptions>): boolean;
/** Stateful per-run counters: per-path explosion + soft-404 duplicate counting. */
export function createTrapTracker(opts: Required<TrapOptions>, logger?: Logger): TrapTracker;
interface TrapTracker {
	/** Called per follow-candidate; true = trap (per-path counter over cap). */
	checkAndCount(url: URL): boolean;
	/** Called per completed page with a hash; true = this hash is now over threshold. */
	countHash(contentHash: string): boolean;
	/** Hashes that crossed softDupThreshold — surfaced in logs and available to recipes. */
	softDupHashes(): string[];
}
```

Enforcement points: `detectUrlTrap` + `checkAndCount` run in the scope pipeline
(item 2, step 9) → `skipReason: "trap"`. `countHash` runs on page completion; once a
hash is over threshold, OUTLINKS of any further page with that hash are not enqueued
(each recorded `skipReason: "trap"`) and one `logger?.warn` names the hash + a sample
URL. All trap skips count under `stats.skippedByReason.trap`.

**Files**
- `src/engine/traps.ts`, `tests/traps.test.ts` (pure checks table-driven; tracker
  tested with synthetic hashes).

**Value/Effort/Risk** — med/M/med; risk = false positives on legitimate large
facet/calendar sections — every cap is per-option tunable and every skip is observable,
which is the mitigation.

**Implementation notes**
- Per-path and per-hash Maps are per-run, in-memory even in PG mode (bounded: one entry
  per distinct path/hash actually seen; document the memory shape). If a future
  distributed mode needs shared trap state, it becomes a store concern — not v1.
- `maxUrlsPerPath` keys on `host + pathname` (query stripped) — exactly the faceted-
  search/calendar signature (tmp/crawler-DESIGN.md:295-297).

## Open questions / decisions needed

1. ~~`PageResult.title` needs a tiny `extractTitle` in `./extract`~~ — RESOLVED during
   plan synthesis: doc 01 item 6 now specs `extractTitle(html, {maxLength})` on the
   shared `_html.ts` scanner.
2. ~~Behavior for non-JSON-serializable `onPage` returns~~ — RESOLVED during plan
   synthesis: doc 03 item 6 pins it (guarded `JSON.stringify`, on throw store NULL +
   one `logger?.warn`, never fail the page write).
3. PG `pop({ excludeHosts })` with hundreds of excluded hosts: whether `host <> ALL($1)`
   stays adequate or needs a host-status side table is doc 03's call; the interface here
   deliberately does not constrain it.
