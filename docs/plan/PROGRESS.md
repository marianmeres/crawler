# Implementation Progress — @marianmeres/crawler

Living tracker for acting on [`00-overview-and-roadmap.md`](./00-overview-and-roadmap.md).
A fresh conversation should read this file first, then the relevant `NN-*.md` section.

**Status legend:** ⬜ not started · 🚧 in progress · ⏸️ blocked/awaiting decision · ✅ done · ⏭️ deferred

> Convention: one branch per sprint, one commit per task. Each task resolves its source
> doc's "Open questions" first (record in the Decisions log), then implement → test →
> tick here. Step zero (scaffold + plan committed on `master`, then branching) is done.

## First sprint (foundations — normalize semantics + contracts + packaging)

Branch: `sprint-01-foundations`

| # | Task | Source | Status | Commit |
|---|------|--------|--------|--------|
| 1 | `normalizeUrl` pipeline + `NormalizeOptions` | [01](./01-url-and-extraction.md) #3 | ✅ | `ff0abf6` |
| 2 | `isSameSite` + registrable-domain heuristic + `classifyLink` | [01](./01-url-and-extraction.md) #1 | ✅ | `04ed377` |
| 3 | `./url` unit-test corpora (incl. idempotency property test) | [01](./01-url-and-extraction.md) #5 | ✅ | `7a37b9e` |
| 4 | Public API surface: all types + `crawl`/`createCrawler` shells | [02](./02-crawl-engine.md) #1 | ✅ | `add24a4` |
| 5 | deno.json: exports map, imports, publish exclude, test task | [05](./05-testing-docs-release.md) #1 | ✅ | `add24a4` |

Sprint 1 is complete.

## Second batch (`./extract` — backlog ranks 6-8)

Branch: `sprint-01-foundations`, continued. Sprint 1 is not merged yet, so this work
stacks on that branch rather than starting a new one off `main`.

| # | Task | Source | Status | Commit |
|---|------|--------|--------|--------|
| 6 | `extractLinks` tokenizer + `extractTitle` + `_html.ts` scanner (incl. `region`) | [01](./01-url-and-extraction.md) #6 | ✅ | `pending-6` |
| 7 | `parseRobotsTxt` + wildcard matcher | [01](./01-url-and-extraction.md) #4 | ✅ | `pending-7` |

## Backlog (ranked, post-sprint)

| Rank | Task | Source | Status |
|------|------|--------|--------|
| 8 | `parseMetaRobots` + `parseXRobotsTag` | [01](./01-url-and-extraction.md) #2 | ⬜ |
| 9 | `./extract` fixture corpora + never-throws fuzz | [01](./01-url-and-extraction.md) #5 | ⬜ |
| 10 | Scope evaluation + `SkipReason` + private-host guard (incl. `followRegions`) | [02](./02-crawl-engine.md) #2 | ⬜ |
| 11 | `FrontierStore`/`VisitedStore` interfaces + memory impls | [02](./02-crawl-engine.md) #3 | ⬜ |
| 12 | Worker pool, politeness, streaming `run()` (incl. `beforeExtract` two-pass) | [02](./02-crawl-engine.md) #5 | ⬜ |
| 13 | Fake-`FetchFn` helper + mini-site + engine tests | [05](./05-testing-docs-release.md) #3 | ⬜ |
| 14 | robots.txt enforcement gate + directives | [02](./02-crawl-engine.md) #4 | ⬜ |
| 15 | Events, stats, safeEmit, id threading | [02](./02-crawl-engine.md) #6 | ⬜ |
| 16 | Budgets + `stoppedBy` semantics | [02](./02-crawl-engine.md) #7 | ⬜ |
| 17 | Trap detection | [02](./02-crawl-engine.md) #8 | ⬜ |
| 18 | `parseSitemap` | [01](./01-url-and-extraction.md) #7 | ⬜ |
| 19 | PG schema DDL (5 tables, tenant-scoped) | [03](./03-pg-persistence.md) #3 | ⬜ |
| 20 | `createCrawlerPg` factory + lifecycle plumbing | [03](./03-pg-persistence.md) #4 | ⬜ |
| 21 | PG test harness (`tests/_pg.ts`, env, gating) | [03](./03-pg-persistence.md) #2 | ⬜ |
| 22 | `PgFrontierStore` / `PgVisitedStore` | [03](./03-pg-persistence.md) #5 | ⬜ |
| 23 | `persistPage` writers (body archive, links, ack) | [03](./03-pg-persistence.md) #6 | ⬜ |
| 24 | Live progress writer (`__crawler_crawl.stats`) | [03](./03-pg-persistence.md) #1 | ⬜ |
| 25 | Consumer query/reporting API (+`getCrawlByJobUid`, `recomputeStats`) | [03](./03-pg-persistence.md) #7 | ⬜ |
| 26 | Incremental re-crawl mechanics (validators, 304 path) | [03](./03-pg-persistence.md) #8 | ⬜ |
| 27 | PG integration tests | [05](./05-testing-docs-release.md) #4 | ⬜ |
| 28 | `./steve` scaffold + serializable payload/result types | [04](./04-steve-jobs-integration.md) #1 | ⬜ |
| 29 | `createCrawlJobHandler` factory | [04](./04-steve-jobs-integration.md) #6 | ⬜ |
| 30 | Failure semantics + crash-resume on retry | [04](./04-steve-jobs-integration.md) #7 | ⬜ |
| 31 | Enqueue + status helpers (`startCrawlJob`, polling) | [04](./04-steve-jobs-integration.md) #2 | ⬜ |
| 32 | AbortSignal wiring | [04](./04-steve-jobs-integration.md) #5 | ⬜ |
| 33 | Reaper + listing-window + type-blind-claiming guidance | [04](./04-steve-jobs-integration.md) #3–4 | ⬜ |
| 34 | Steve integration tests + e2e | [04](./04-steve-jobs-integration.md) #9, [05](./05-testing-docs-release.md) #7 | ⬜ |
| 35 | `scripts/build-npm.ts` real dependency list + entry points | [05](./05-testing-docs-release.md) #2 | ⬜ |
| 36 | Recipes/examples dir (6 recipes) + job-mode recipe | [05](./05-testing-docs-release.md) #9, [04](./04-steve-jobs-integration.md) #8 | ⬜ |
| 37 | README + AGENTS.md + `.env.example` | [05](./05-testing-docs-release.md) #5 | ⬜ |
| 38 | Release flow checklist + dry-runs; mcp.ts backlog note | [05](./05-testing-docs-release.md) #8 | ⬜ |

## Open questions (collected; resolve with owner before the affected task)

- [01/02] Userinfo credentials in URLs (`https://user:pass@host/…`) — the `./url` half
  is settled (kept verbatim, see Decisions log). Still open: does the crawl loop REFUSE
  such URLs at enqueue, REDACT them before persisting, or pass them through? (tasks 12, 23)
- [02] PG `pop({excludeHosts})` scaling with hundreds of hosts — `<> ALL($1)` vs a
  host-status side table; doc 03's call at implementation. (task 22)
- [03] `__crawler_url` archive pruning: ship `pruneUrls()` in v1 or leave to consumer
  SQL? (task 25)
- [03] Cross-tenant body duplication under the `(tenant_id, url)` key — accepted, or
  dedupe bodies across tenants? (task 19)
- [04] Ship `resumeCrawlJob()` convenience or document the manual
  `startCrawlJob(..., {crawlUid})` two-step only? (lean: document only) (task 31)
- [05] PG-gated tests: silent ignore vs printed skip notice when `TEST_PG_*` unset
  (suggest silent ignore, documented in AGENTS.md). (tasks 21, 27)
- [05] `docs/RELEASING.md` vs release section in AGENTS.md. (task 38)
- [05] Include `@marianmeres/steve` in npm optional peers only if `./steve` emits steve
  types in its `.d.ts` — decide at implementation. (task 35)

## Decisions log

- **2026-08-24** — Layered modes: memory stores default, `./pg` opt-in submodule (never
  PG-only) — owner interview; memory stores are needed for tests anyway.
- **2026-08-24** — PG persists crawl state + results + RAW BODIES; body model is
  latest-per-URL (replaced on `content_hash` change), per-run tables reference URL rows
  — owner interview ("the whole point is to fetch HTML bodies to consume later").
- **2026-08-24** — Bodies never go into steve's job `result` JSONB (30-min `fetchAll`
  window, cleanup lifecycle) — agreed during interview.
- **2026-08-24** — Steve integration: ONE CRAWL = ONE JOB; per-URL fetched/failed
  reporting served by crawler-owned tables (owner delegated conditional on equivalent
  reports; condition met — `__crawler_page` rows are written live per completed page).
- **2026-08-24** — html→markdown / sanitize-html out of scope (`onPage` is the escape
  hatch) — owner interview.
- **2026-08-24** — `tenant_id TEXT NOT NULL DEFAULT '_default'`, cron-3.x style — owner
  interview.
- **2026-08-24** — [01 open q, `./url` half] `normalizeUrl` KEEPS userinfo verbatim:
  `./url` is a lossless pure function, so refusing or redacting credentials is an
  enqueue/persist-time policy decision, not a parsing one. Doc 01's own recommendation
  adopted; the crawl-loop half of the question stays open above. (task 1)
- **2026-08-24** — Two doc-01 pipeline steps widened so the REQUIRED idempotency
  property actually holds: trailing-slash strip removes ALL trailing slashes and
  `stripWww` removes ALL leading `www.` labels, not one each. The "drop one" spellings
  need two passes to reach a fixed point on `/dir///` (with `collapseSlashes: false`)
  and on `www.www.a.com`. (task 1)
- **2026-08-24** — `isSameSite` scope modes are MONOTONE: `"same-site"` falls back to
  host equality when a host has no registrable domain. Doc 01 spec'd `null => false`,
  which would make a crawl seeded at a bare public suffix — or at `localhost` under an
  injected strict-PSL resolver — treat its own seed host as external and follow nothing.
  The fallback only ever accepts exact same-host pairs, so it cannot widen scope beyond
  `"same-host"`. Found by the task-3 property test. (task 3)
- **2026-08-24** — The `./url` fixture corpus is loaded via a STATIC JSON import rather
  than `Deno.readTextFile`. Static imports are part of the module graph and need no
  `--allow-read`, so the `./url` suite runs standalone under the current bare
  `deno test` task instead of waiting for doc 05's `deno test -A`. (task 3)
- **2026-08-24** — `normalizeUrl` gained a step 12 REASSEMBLY GUARD: for any scheme
  outside `http:`/`https:` (reachable only by widening `allowSchemes`) the assembled
  string is re-parsed and rejected unless every component survives verbatim. The manual
  step-10 join is not the WHATWG serializer, and three confirmed classes broke it —
  opaque paths keeping raw spaces (`mailto:`, `data:`), a non-numeric `url.port`
  (`git:/.//x` → `git::./x`), and a `file:` path whose first segment reads as a Windows
  drive letter (silently dropping the host). The guard is gated on the scheme, so the
  http(s) hot path stays at exactly one `URL` parse. (task 3, adversarial review)
- **2026-08-24** — The DNS root label is dropped from the host unconditionally
  (`a.com.` → `a.com`), in `normalizeUrl` AND in `./url`'s host comparison. WHATWG keeps
  it, so without this one server is two frontier keys and `same-host` calls a page
  off-site from itself. Not toggleable — it is a host-identity fact, not a policy.
  (task 3, adversarial review)
- **2026-08-24** — Trailing-slash stripping and the root-label strip are hand-written
  scans, not regexes: `/\/+$/` backtracks quadratically on a long slash run that does
  not end in a slash (~20s of blocked event loop for a 200k-slash href, and the length
  cap runs too late to help). A hostile `href` is attacker-controlled input on every
  crawl, so this was a real DoS. Pinned by a linearity test. (task 3, adversarial review)
- **2026-08-24** — An injected `getRegistrableDomain` is called defensively: a throw, or
  any return that is not a non-empty string, is treated as "no registrable domain". It is
  the only foreign code these otherwise-pure modules run, and an `undefined` return would
  otherwise have compared equal and made every host same-site. (task 3, adversarial review)
- **2026-08-24** — Design-sketch deviations (synthesis, per verified constraints):
  default fetcher is the HTTP adapter (browser drivers are injected, never bundled);
  `checkpoint()`/`checkpointEvery` dropped; SQLite dropped; `maxTotalBytes` rename;
  robots 5xx = disallow-all; same-site via heuristic + injectable PSL override; sketch
  §13 open questions adopted as suggested (canonical recorded, redirect-as-attribute,
  nearest-seed depth, pluggable priority, skips-as-events).

- **2026-08-24** — The `exports` map (and the self-referencing `imports` entries) ship
  only the submodules that EXIST. Doc 05 item 1 specs six keys; `./extract`, `./pg` and
  `./steve` point at files that are not written, and a dangling exports target fails both
  `deno check` and `deno publish`. The map grows one entry per submodule as it lands —
  today `.`, `./url`, `./stores`. (task 5)
- **2026-08-24** — Dependencies enter `imports` when the first line of code imports them,
  not up front. Doc 05 item 1 also lists `pg`, `@types/pg`, `@marianmeres/steve` and
  `@std/testing`; nothing references them yet, so they would only sit in `deno.lock`
  ahead of the tasks that pick them. `@marianmeres/clog` is not needed at all on the
  Deno/JSR side — `Logger` reaches us re-exported through page-fetcher. (The npm build
  still needs clog spelled out for the emitted `.d.ts`; that is task 35.) (task 5)
- **2026-08-24** — The store CONTRACTS ship with task 4, their memory implementations
  with task 11. `CrawlOptions.stores`, `CrawlOptions.priority` and `PageContext.item`
  cannot be spelled without `FrontierStore`/`VisitedStore`/`FrontierItem`, so doc 02
  item 3's `src/stores/types.ts` is part of "the public API surface" by construction.
  Same reasoning put `ExtractOptions` in `src/extract/types.ts` ahead of doc 01 item 6 —
  `CrawlOptions.extract` needs it, and task 6 will import it rather than move it. (task 4)
- **2026-08-24** — `src/options.ts` (`resolveCrawlOptions`) added; not in doc 02's file
  list. The defaults documented on `CrawlOptions` ARE the contract, and a contract no
  code executes drifts from the behavior — so they live in one resolver, and the whole
  default table is a single test assertion. It also moves validation to construction
  time: `createCrawler({ concurrency: 0 })` is a `TypeError` rather than a crawl that
  quietly dispatches nothing. Tasks 10/12 consume the `Resolved*Options` shapes it
  defines (`pathPrefix` always an array, unset budgets/caps as `Infinity`). (task 4)
- **2026-08-24** — A cap of `0` is REJECTED, never read as "unlimited". Doc 02 item 8
  says so for `TrapOptions`; extended to every `> 0` knob (concurrency, maxQueued, the
  four budgets, `scope.maxUrlLength`, `extract.maxLinks`, `robots.maxBytes`). `Infinity`
  is how "no limit" is spelled. Delays and intervals are the exception — `0` is
  meaningful there, negatives are not. (task 4)
- **2026-08-24** — `crawl()` DEFAULTS `collect` to `{pages: true, graph: true}` instead
  of forcing it as doc 02 item 1 spells it. Identical for the documented use; the
  difference is that `crawl(seeds, { collect: { graph: false } })` now saves the graph
  memory instead of being silently overridden. (task 4)
- **2026-08-24** — `src/url/mod.ts` re-exports an explicit list, not `export *`. The
  wildcard was pushing `canonPercentEncoding` — marked `@internal — exported for tests
  only` — into the published `.` and `./url` surfaces. Each `mod.ts` now has a test
  pinning its exact runtime export list, so the next accidental leak fails CI rather
  than shipping. (task 4, touches task 3's file)
- **2026-08-24** — The `Crawler` shells throw a uniform, greppable "not implemented yet"
  from every engine-backed member, EXCEPT `[Symbol.asyncDispose]`, which resolves:
  disposal releases engine-owned fetchers and a crawler that never ran owns none, so
  that one is correct rather than stubbed. Half-working crawl semantics would be worse
  than a throw. (task 4)

- **2026-08-24** — **Region scoping promoted into v1** (was the design sketch's
  "nice-to-have, not v1" at tmp/crawler-DESIGN.md:256-258). Driven by the real use case:
  follow only in-`<main>` content links, ignore header/nav/footer chrome. Shape:
  `RawLink.region`/`LinkRecord.region` (innermost landmark, always tracked, no option) +
  `scope.followRegions` (default `[]` = off) + `SkipReason: "out-of-region"`. Three
  rules: filtering happens in scope not extraction (chrome links stay in the graph);
  innermost-wins so `["main", "article"]` is the documented value; whole-document
  fallback when a page has no landmarks at all, warned once per crawl. Rejected the
  alternative of a `beforeExtract(html)` hook + html-extract for this case — it needs a
  second package and a tree parser for what a tag-depth stack does natively. That hook
  remains the documented escape hatch for div-soup sites, deferred until needed.
  Applied to docs 01/02/05 and to the already-landed `src/types.ts`, `src/options.ts`,
  `src/extract/types.ts` and `tests/options.test.ts`. (tasks 6, 10)

- **2026-08-24** — **`beforeExtract` hook accepted into v1** (not deferred). Region
  scoping matches element names only, so `<div class="main">` — the common case, not the
  exotic one — has nothing to match; the hook lets the consumer narrow the HTML with
  `@marianmeres/html-extract` before body links are discovered. Kept a hook rather than a
  crawler dependency on html-extract: the core jobs (link checking, sitemap generation,
  graph building) need no DOM, and JSR has no `optionalDependencies`, so a direct dep
  would tax every such user with a parser they never call. The ergonomic objection is
  answered by a one-line recipe plus equal billing for both modes in the README, not by
  the dependency. Binding detail: extraction becomes **two passes** — `<head>`-derived
  data (title, canonical, next/prev, meta-refresh, meta-robots) always from the raw
  document, anchors/assets from the narrowed HTML — and raw bytes (contentHash, size,
  body archive) are never affected. A throwing hook degrades to the full document with
  one warning. Applied to docs 02/05 and to the landed `src/types.ts`, `src/options.ts`,
  `tests/options.test.ts`. (tasks 12, 37)

- **2026-08-24** — `beforeExtract` verified end-to-end against the now-published
  `@marianmeres/html-extract` v0.3.0 (284 tests green there; linkedom parser, single
  export, no parser types in its public API, `clean()` carries the not-a-sanitizer
  disclaimer). The contract `extractMainContent(html)?.html ?? html` holds as specified:
  returns `MainContent | null` with `.html`, throws only on non-string input. Probe
  findings folded into doc 02: hrefs survive verbatim (relative stays relative);
  `<nav>`/`<header>`/`<footer>`/`<aside>` are already dropped by the extractor; and — the
  one **bug found in our own spec** — `<base href>` is gone from the narrowed HTML, so
  the engine must compute the effective base once from the raw document and pass it to
  *both* extraction passes instead of letting the body pass re-derive it. Without that,
  every relative link on a `<base>`-bearing page resolves wrongly and silently. Test
  required in doc 05. (task 12)

- **2026-08-24** — `extractLinks` gained a **`detectBase` option** (`ExtractLinksOptions`,
  default `true`, not part of the consumer-facing `ExtractOptions`). Doc 02 requires that
  under `beforeExtract` the body pass "must never be allowed to fall back to its own
  `<base>` lookup", and nothing in doc 01's signature could express that — passing the
  precomputed base as `baseUrl` is not enough, because a `<base href>` surviving in the
  narrowed HTML would still win. Keeping it off `ExtractOptions` keeps it out of
  `CrawlOptions.extract` and out of the pinned default table. (task 6, serves task 12)

- **2026-08-24** — The `ExtractOptions` defaults live in ONE place,
  `DEFAULT_EXTRACT_OPTIONS` in `./extract`, and `resolveCrawlOptions` reads them instead
  of repeating the literals. Values in `./extract`, validation in `src/options.ts` — a
  standalone `extractLinks()` call never throws on a bad number (it falls back to the
  default), while `createCrawler({extract: {maxLinks: 0}})` still must. A test asserts the
  two tables are equal. (task 6)

- **2026-08-24** — `RawLink.tag` and `RawLink.rel` are closed unions (`RawLinkTag`,
  `RawLinkRel`), not the `tag: string` of doc 01's spec — the same doc calls the tag list
  closed ("new sources are an options change, not a heuristic"), so the type should say
  so. `LinkRel` in `src/types.ts` is now literally `RawLinkRel | "sitemap"`, which is what
  its JSDoc always claimed. (task 6)

- **2026-08-24** — `<link rel=alternate>` is extracted with or without `hreflang` (the
  `hreflang` is recorded when present), so `alternate: true` also discovers RSS/Atom
  feeds; `rel="alternate stylesheet"` is classified as an asset, not an alternate. One
  `<link>` yields at most one edge, precedence canonical > next > prev > stylesheet >
  alternate. `rel=previous` is accepted as `prev`. (task 6)

- **2026-08-24** — Scanner tolerances worth knowing, all of them browser behavior:
  `<script>`/`<style>`/`<title>`/`<textarea>` content is raw text (an unclosed one
  swallows the rest of the document, exactly as in a browser), `<noscript>` content is
  NOT — those links are real for a non-scripting client, which is what a crawler is. A
  quote only opens a quoted value where a value can start, so `<a href=a"b>` cannot
  swallow the document; `<a href=/>` is an href of `"/"`, not a self-closing tag. An
  empty href is dropped, a fragment-only href (`#top`) is kept — filtering belongs to
  scope, and normalization already turns it into the page's own URL. (task 6)

- **2026-08-24** — The robots matcher is a **hand-written two-pointer glob**, not the
  regex compilation doc 01 item 4 specs. `*` → `[\s\S]*` in a backtracking engine is a
  denial-of-service any site can trigger: `Disallow: /a*a*a*a*a*a*a*a*b` against a long
  path explores every way to split the path between the stars before reporting no match.
  The two-pointer matcher is O(pattern x path) worst case, needs no metacharacter
  escaping pass (a `(` in a path is just a character), and is pinned by a timing test.
  Same class of finding as task 3's quadratic-regex entry. (task 7)

- **2026-08-24** — `isAllowed(pathAndQuery, ua)` is tolerant about its first argument: a
  whole URL is reduced to `pathname + search`, a missing leading `/` is added, a fragment
  is dropped, and an empty/non-string target reads as `/`. Passing a full URL is the
  obvious caller mistake, and the untolerant reading answers "allowed" for every URL on
  the site — failing open, silently. (task 7)

- **2026-08-24** — Robots details doc 01 left open: an empty `Allow:` contributes nothing
  (same as the spec'd empty `Disallow:`) — an empty allow pattern would match everything
  and cancel the rest of the file; within one group the FIRST `Crawl-delay` wins, and
  across several groups addressing one agent the LARGEST does (being slower than asked is
  never a violation); only `Allow`/`Disallow`/`Crawl-delay` end a group's `User-agent`
  block, so a stray `Host:` between two `User-agent:` lines does not split the group.
  (task 7)

## How to resume (for a fresh conversation)

1. Read this file + `00-overview-and-roadmap.md`.
2. Pick the next ⬜ task; open its source doc section for the verified detail.
3. Resolve that task's "Open questions" with the owner; record in the Decisions log.
4. Branch → implement → run the test suite → update this file → commit when the owner
   asks.
