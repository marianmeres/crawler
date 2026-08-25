<!--
GENERATED PLAN — @marianmeres/crawler, remaining v1 work (was docs/plan backlog ranks 15-18)
Produced 2026-08-25 by re-cutting docs/plan/PROGRESS.md's open backlog into the current
MULTISTEP_PROGRESS_FILESYSTEM_LAYOUT_INSTRUCTIONS.md + sprint/SPEC.md tracker format.
Claims re-verified against the working tree at commit cebf5d0. No code was changed.
-->

# Engine completion — events, budgets, traps, sitemaps

> The engine runs: dispatcher, politeness, scope, robots and the streaming `run()` all
> landed in tasks 12-14. What is left is the set of knobs that are **declared in the
> public types, resolved by `resolveCrawlOptions`, and read by nothing** — events,
> the three budgets, trap detection — plus the sitemap parser the robots gate is already
> holding a door open for.
>
> That "declared but inert" shape is the whole risk of this sprint: every one of these
> tasks is a wiring job whose type surface already exists and is already pinned by
> `tests/options.test.ts`. Do not re-design the options; implement what they promise.
>
> Full specs live in [`../plan/02-crawl-engine.md`](../plan/02-crawl-engine.md) §6-§8 and
> [`../plan/01-url-and-extraction.md`](../plan/01-url-and-extraction.md) §7. This doc adds
> the current state of the tree, the **Done when** criterion, and the affected files.

## Summary

| # | Task | Value | Effort | Risk |
|---|------|-------|--------|------|
| T15 | Events, `safeEmit`, throttled progress | med | S | low |
| T16 | Budgets + `stoppedBy` | med | S | low |
| T17 | Trap detection | med | M | med |
| T18 | `parseSitemap` + robots `Sitemap:` seeding | med | M | low |
| T39 | Mask userinfo credentials in every message | med | S | low |

## Tasks

### T15 — Events, stats, `safeEmit`, id threading

**Where it stands** — `src/engine/stats.ts` already carries the counters, the
`byHost` cap (`BY_HOST_SNAPSHOT_LIMIT = 100`) and `snapshot()`; it landed early with
task 12 because `PageContext.stats` and `CrawlReport.stats` are typed as a full
`CrawlStats`. `CrawlEvents` is declared (`src/types.ts:522`) and `progressInterval` is
resolved (`src/options.ts:289`). **Nothing calls a handler.**

**What to build** — [`../plan/02-crawl-engine.md`](../plan/02-crawl-engine.md) §6 in
full: `safeEmit(name, fn)` (try/catch → `logger?.warn`, never rethrow, return value
ignored, async handlers not awaited — document it), every event call site
(`onStart`, `onPageStart`, `onPageDone`, `onPageError`, `onLinkSkipped`, `onProgress`,
`onEnd`), and the `progressInterval` timer plus exactly one final emit before `onEnd`.

The hook/event split is load-bearing and already half-implemented: `onPage`,
`shouldVisit`, `onLink` and `priority` produce data, so a throw there fails the page (or
falls back, for `priority`) — they are **not** `safeEmit`-wrapped. Events only observe.

**Done when** — a new `tests/events.test.ts` passes in which: (a) one fixture crawl fires
all seven events with the documented payloads, in a legal order; (b) the same crawl with
a handler that throws on *every* event produces a `CrawlReport` deep-equal to the crawl
with no handlers at all; (c) `onProgress` fires no more than once per `progressInterval`
and exactly once more immediately before `onEnd`.

**Affected files** — `src/engine/stats.ts`, `src/engine/dispatcher.ts`, `src/crawler.ts`,
`tests/events.test.ts`.

**Notes** — the snapshot must stay JSON-serializable: T24 writes it straight into a
JSONB column. `crawlId` is already threaded; per-page `requestId` comes off
`FetchResult`, the engine never invents one (`dispatcher.ts:611`).

### T16 — Budgets and `stoppedBy` semantics

**Where it stands** — `maxPages`/`maxDuration`/`maxTotalBytes` are validated and default
to `Infinity` (`src/options.ts:218-220`), `StoppedBy` already ranges over all six values
(`src/types.ts:480`), and the dispatcher latches only `completed`/`stop`/`abort`.

**What to build** — [`../plan/02-crawl-engine.md`](../plan/02-crawl-engine.md) §7: each
budget checked in exactly one place, all three taking the existing graceful-stop path
(in-flight drains, dispatch stops); first budget crossed wins and is latched; `abort`
overrides everything; `stop` wins over a budget only if it latched first. Links
discovered after the page cap record `skipReason: "max-pages"`; already-queued items are
left queued, never converted into skips.

`maxDepth` is deliberately **not** a `stoppedBy` value — it prunes expansion and the
crawl then ends `completed`. That asymmetry is the one thing a reader will want to
"fix"; it is intentional.

**Done when** — `tests/crawler-limits.test.ts` (the file doc 05 §3 specified and task 13
deferred to this rank) passes: one crawl per budget asserting `report.stoppedBy`, that
in-flight pages are still delivered, that `maxTotalBytes` may overshoot by at most
`concurrency` responses, and that a `maxDepth`-only crawl ends `completed` with
`stats.skippedByReason["max-depth"] > 0`.

**Affected files** — `src/engine/dispatcher.ts`, `src/crawler.ts`,
`tests/crawler-limits.test.ts`.

### T17 — Trap detection

**Where it stands** — `TrapOptions` is declared (`src/types.ts:165`) and fully resolved
with its five defaults (`src/options.ts:261-273`, each `> 0`-validated, `Infinity` =
off). No file reads them.

**What to build** — [`../plan/02-crawl-engine.md`](../plan/02-crawl-engine.md) §8:
`src/engine/traps.ts` exporting the pure `detectUrlTrap(url, opts)` (segment repeats,
path depth, query-param count) and the stateful `createTrapTracker(opts, logger)`
(`checkAndCount` per follow-candidate for the per-`(host, pathname)` explosion counter,
`countHash` per completed page for soft-404 duplicates, `softDupHashes()`). Enforcement
sits in the scope pipeline as `skipReason: "trap"`; once a `contentHash` is over
`softDupThreshold`, outlinks of any further page carrying it are not enqueued and one
`logger?.warn` names the hash and a sample URL.

**Done when** — `tests/traps.test.ts` passes with table-driven cases for every cap
**including its boundary** (at the cap allowed, one over rejected — the task-9 lesson
that an unbounded guard can be deleted without a single test noticing), a tracker test
for the per-path and per-hash counters, and one engine-level test where a synthetic
calendar fixture (`/2026/01/02` linking to the next day forever) terminates with the
skips counted under `stats.skippedByReason.trap`.

**Affected files** — `src/engine/traps.ts`, `src/engine/scope.ts`,
`src/engine/dispatcher.ts`, `tests/traps.test.ts`.

**Notes** — the maps are per-run and in memory even in PG mode; document the memory
shape (one entry per distinct path and per distinct hash actually seen).

### T18 — `parseSitemap` + robots `Sitemap:` seeding

**Where it stands** — the robots gate already parses `Sitemap:` lines and exposes
`sitemapUrls(origin)` (`src/engine/robots-gate.ts:76,199`); `robots.sitemaps: true`
currently warns once and seeds nothing, which task 14 recorded as this rank's job.

**What to build** — two halves.

1. The parser, exactly as
   [`../plan/01-url-and-extraction.md`](../plan/01-url-and-extraction.md) §7 specs it:
   `parseSitemap(text)` → `{kind: "urlset", entries}` | `{kind: "sitemapindex", sitemaps}`,
   tolerant regex/`indexOf` scanning, CDATA + entity decoding in `<loc>`, the plain-text
   fallback, a 50 000-entry cap, never throws. Reuse `./extract`'s existing entity
   decoder — do not write a second one.
2. The seeding: when `robots.sitemaps` is true, the gate's `sitemapUrls(origin)` are
   fetched with the crawl's own transport (the same rule task 14 settled for robots.txt),
   parsed, and enqueued as `discoveredVia: "sitemap"` at depth 0 through the **normal**
   scope + robots pipeline. A `sitemapindex` is followed one level; cap the whole thing
   at 50 sitemap documents per origin and log when the cap truncates. A `.xml.gz` body is
   gunzipped with `DecompressionStream("gzip")` before parsing.

**Done when** — `tests/extract/sitemap.test.ts` covers urlset, sitemapindex, plain-text,
CDATA, entities, namespace prefixes, the entry cap and a "garbage never throws" fuzz
step; and `tests/crawler-sitemap.test.ts` proves an origin whose robots.txt carries a
`Sitemap:` line ends with those URLs crawled and marked `discoveredVia: "sitemap"`, with
the warn-once stub gone. The gunzip path is unit-tested against a gzipped fixture rather
than through the fake transport.

**Affected files** — `src/extract/sitemap.ts`, `src/extract/mod.ts`,
`src/engine/dispatcher.ts` (seeding), `src/engine/robots-gate.ts`,
`tests/extract/sitemap.test.ts`, `tests/crawler-sitemap.test.ts`.

**Notes** — `src/extract/mod.ts` re-exports an explicit list and a test pins it
(task 4's decision); add `parseSitemap` and its types to both.

### T39 — Userinfo credentials: verbatim in the data, masked in every message

**Where this came from** — the 2026-08-25 owner decision in `PROGRESS.md`: a URL like
`https://user:pass@host/…` stays **verbatim** everywhere it is load-bearing (frontier
key, fetch, `PageResult.url`, and later the PG rows), because such URLs are legitimately
crawlable and stripping them would break the crawl. The mitigation is that credentials
must never appear in anything a human or a log aggregator reads.

**What to build** — an internal `maskUserinfo(url)` (`https://user:***@host/…`, input
returned unchanged when there is no userinfo, never throws, never re-parses a
non-URL string) and its application at **every** site in `src/**` where a URL is
interpolated into a `logger?.*` call, an `Error` message or a warning. Data paths are
untouched: `PageResult`, `LinkRecord`, frontier items and store keys keep the URL exactly
as normalized.

**Done when** — `tests/mask-userinfo.test.ts` pins the helper (userinfo present/absent,
username-only, encoded `@`, non-URL input), and a crawl of a credential-bearing seed
against a recording logger — driven through the warn paths that exist today (robots
disallow, a throwing hook, a `priority` fallback, an unsupported content type) — produces
no message containing the password, while `report.pages[0].url` still carries it.

**Affected files** — `src/url/_mask-userinfo.ts` (internal, **not** re-exported from
`./url` — the export-list test would fail), `src/engine/dispatcher.ts`,
`src/engine/robots-gate.ts`, `src/engine/scope.ts`, `src/crawler.ts`,
`tests/mask-userinfo.test.ts`.

**Notes** — T23 and T30 must use the same helper for their own log lines; the README
note about preferring fetcher headers for authentication is T37's.
