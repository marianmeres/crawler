# Implementation Progress — @marianmeres/crawler

Living tracker for acting on [`00-overview-and-roadmap.md`](./00-overview-and-roadmap.md).
A fresh conversation should read this file first, then the relevant `NN-*.md` section.

**Status legend:** ⬜ not started · 🚧 in progress · ⏸️ blocked/awaiting decision · ✅ done · ⏭️ deferred

> Convention: one branch per sprint, one commit per task. Each task resolves its source
> doc's "Open questions" first (record in the Decisions log), then implement → test →
> tick here. Step zero (scaffold + plan committed on `master`, then branching) is done.

## First sprint (foundations — normalize semantics + contracts + packaging)

Branch: `sprint-01-foundations`

| # | Task                                                           | Source                                | Status | Commit    |
| - | -------------------------------------------------------------- | ------------------------------------- | ------ | --------- |
| 1 | `normalizeUrl` pipeline + `NormalizeOptions`                   | [01](./01-url-and-extraction.md) #3   | ✅     | `ff0abf6` |
| 2 | `isSameSite` + registrable-domain heuristic + `classifyLink`   | [01](./01-url-and-extraction.md) #1   | ✅     | `04ed377` |
| 3 | `./url` unit-test corpora (incl. idempotency property test)    | [01](./01-url-and-extraction.md) #5   | ✅     | `7a37b9e` |
| 4 | Public API surface: all types + `crawl`/`createCrawler` shells | [02](./02-crawl-engine.md) #1         | ✅     | `add24a4` |
| 5 | deno.json: exports map, imports, publish exclude, test task    | [05](./05-testing-docs-release.md) #1 | ✅     | `add24a4` |

Sprint 1 is complete.

## Second batch (`./extract` — backlog ranks 6-8)

Branch: `sprint-01-foundations`, continued. Sprint 1 is not merged yet, so this work
stacks on that branch rather than starting a new one off `main`.

| # | Task                                                                            | Source                              | Status | Commit    |
| - | ------------------------------------------------------------------------------- | ----------------------------------- | ------ | --------- |
| 6 | `extractLinks` tokenizer + `extractTitle` + `_html.ts` scanner (incl. `region`) | [01](./01-url-and-extraction.md) #6 | ✅     | `4c5cd07` |
| 7 | `parseRobotsTxt` + wildcard matcher                                             | [01](./01-url-and-extraction.md) #4 | ✅     | `4f7a2a5` |
| 8 | `parseMetaRobots` + `parseXRobotsTag`                                           | [01](./01-url-and-extraction.md) #2 | ✅     | `0914574` |

## Third batch (corpora + scope + stores — backlog ranks 9-11)

Branch: `sprint-01-foundations`, continued.

| #  | Task                                                                         | Source                              | Status | Commit    |
| -- | ---------------------------------------------------------------------------- | ----------------------------------- | ------ | --------- |
| 9  | `./extract` fixture corpora + never-throws fuzz                              | [01](./01-url-and-extraction.md) #5 | ✅     | `33c3d53` |
| 10 | Scope evaluation + `SkipReason` + private-host guard (incl. `followRegions`) | [02](./02-crawl-engine.md) #2       | ✅     | `7a3dd00` |
| 11 | `FrontierStore`/`VisitedStore` interfaces + memory impls                     | [02](./02-crawl-engine.md) #3       | ✅     | `0778cbb` |

## Fourth batch (the engine — backlog ranks 12-14)

Branch: `sprint-01-foundations`, continued.

| #  | Task                                                                        | Source                                | Status | Commit    |
| -- | --------------------------------------------------------------------------- | ------------------------------------- | ------ | --------- |
| 12 | Worker pool, politeness, streaming `run()` (incl. `beforeExtract` two-pass) | [02](./02-crawl-engine.md) #5         | ✅     | `abf175b` |
| 13 | Fake-`FetchFn` helper + mini-site + engine tests                            | [05](./05-testing-docs-release.md) #3 | ✅     | `TBD13`   |
| 14 | robots.txt enforcement gate + directives                                    | [02](./02-crawl-engine.md) #4         | ⬜     |           |

## Backlog (ranked, post-sprint)

| Rank | Task                                                                 | Source                                                                         | Status |
| ---- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------ |
| 15   | Events, stats, safeEmit, id threading                                | [02](./02-crawl-engine.md) #6                                                  | ⬜     |
| 16   | Budgets + `stoppedBy` semantics                                      | [02](./02-crawl-engine.md) #7                                                  | ⬜     |
| 17   | Trap detection                                                       | [02](./02-crawl-engine.md) #8                                                  | ⬜     |
| 18   | `parseSitemap`                                                       | [01](./01-url-and-extraction.md) #7                                            | ⬜     |
| 19   | PG schema DDL (5 tables, tenant-scoped)                              | [03](./03-pg-persistence.md) #3                                                | ⬜     |
| 20   | `createCrawlerPg` factory + lifecycle plumbing                       | [03](./03-pg-persistence.md) #4                                                | ⬜     |
| 21   | PG test harness (`tests/_pg.ts`, env, gating)                        | [03](./03-pg-persistence.md) #2                                                | ⬜     |
| 22   | `PgFrontierStore` / `PgVisitedStore`                                 | [03](./03-pg-persistence.md) #5                                                | ⬜     |
| 23   | `persistPage` writers (body archive, links, ack)                     | [03](./03-pg-persistence.md) #6                                                | ⬜     |
| 24   | Live progress writer (`__crawler_crawl.stats`)                       | [03](./03-pg-persistence.md) #1                                                | ⬜     |
| 25   | Consumer query/reporting API (+`getCrawlByJobUid`, `recomputeStats`) | [03](./03-pg-persistence.md) #7                                                | ⬜     |
| 26   | Incremental re-crawl mechanics (validators, 304 path)                | [03](./03-pg-persistence.md) #8                                                | ⬜     |
| 27   | PG integration tests                                                 | [05](./05-testing-docs-release.md) #4                                          | ⬜     |
| 28   | `./steve` scaffold + serializable payload/result types               | [04](./04-steve-jobs-integration.md) #1                                        | ⬜     |
| 29   | `createCrawlJobHandler` factory                                      | [04](./04-steve-jobs-integration.md) #6                                        | ⬜     |
| 30   | Failure semantics + crash-resume on retry                            | [04](./04-steve-jobs-integration.md) #7                                        | ⬜     |
| 31   | Enqueue + status helpers (`startCrawlJob`, polling)                  | [04](./04-steve-jobs-integration.md) #2                                        | ⬜     |
| 32   | AbortSignal wiring                                                   | [04](./04-steve-jobs-integration.md) #5                                        | ⬜     |
| 33   | Reaper + listing-window + type-blind-claiming guidance               | [04](./04-steve-jobs-integration.md) #3–4                                      | ⬜     |
| 34   | Steve integration tests + e2e                                        | [04](./04-steve-jobs-integration.md) #9, [05](./05-testing-docs-release.md) #7 | ⬜     |
| 35   | `scripts/build-npm.ts` real dependency list + entry points           | [05](./05-testing-docs-release.md) #2                                          | ⬜     |
| 36   | Recipes/examples dir (6 recipes) + job-mode recipe                   | [05](./05-testing-docs-release.md) #9, [04](./04-steve-jobs-integration.md) #8 | ⬜     |
| 37   | README + AGENTS.md + `.env.example`                                  | [05](./05-testing-docs-release.md) #5                                          | ⬜     |
| 38   | Release flow checklist + dry-runs; mcp.ts backlog note               | [05](./05-testing-docs-release.md) #8                                          | ⬜     |

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
  _both_ extraction passes instead of letting the body pass re-derive it. Without that,
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

- **2026-08-24** — `X-Robots-Tag` details doc 01 left to implementation: a `botname:`
  group runs until the NEXT group starts (Google's own examples read that way), so the
  `Headers.get()` join of `googlebot: nofollow` + `noindex` attributes the unscoped
  `noindex` to googlebot — lossy, unavoidable after joining, documented on the function.
  Scope matching reuses the robots.txt rule (the group token is a case-insensitive
  substring of `botName`), so `googlebot` addresses `googlebot/2.1`; with no `botName`
  only unscoped directives apply. `raw` holds only tokens that APPLIED. (task 8)

- **2026-08-24** — `parseAttrs` on a quoted attribute value whose closing quote never
  arrives (the tag ran into EOF) keeps the text after the quote, not the quote character.
  Found by a `parseMetaRobots("<meta name=robots content=\"")` test, which was reporting
  a directive token of `"`. (task 8, touches task 6's file)

- **2026-08-24** — The `./extract` fixture corpus lives in `tests/extract/fixtures.test.ts`,
  next to but separate from the inline suite doc 01 §5's layout folds it into. The two
  answer different questions: the inline file pins one construct at a time, the fixture
  file pins whole documents — the interactions that only appear when a `<base>`, a
  `<script>` and an unclosed `<nav>` are on the same page. `tests/_fixtures.ts` is the
  shared loader. `tests/fixtures/sitemaps/**` and `sitemap.test.ts` are NOT part of this
  task: `parseSitemap` is backlog rank 18, and a fixture with no parser is a fixture that
  rots. (task 9)

- **2026-08-24** — Two fixtures doc 01 §5 describes as _large_ are GENERATED at test
  setup rather than committed: `giant.html` (the doc says so itself) and the 100k-line
  half of `robots/hostile.txt` (the doc does not, but the same reasoning applies — the
  committed file carries the nasty _shapes_, the volume is built in-test). Both soft caps
  of doc 01 §4 are now pinned: `MAX_PATTERN_LENGTH` by the committed file,
  `MAX_LINES` by the generated one. (task 9)

- **2026-08-24** — **`decodeEntities` was quadratic on attacker-controlled input, and the
  fuzz suite found it on its first run.** `text.indexOf(";", amp + 1)` scanned to the end
  of the document for every `&` that was not an entity, so a query string of 200 000 bare
  ampersands — a plain `href` any site can serve — cost ~0.9s of blocked event loop, and
  400 000 cost ~4.8s. The `;` search is now bounded by `MAX_ENTITY_LENGTH`, which is
  where the old code rejected the match anyway, so nothing about the result changed:
  400k ampersands went from 2 960 ms to 39 ms. This runs on every attribute value of
  every tag, i.e. the hottest path in the package. Third finding of this class here,
  after the quadratic trailing-slash regex (task 3) and the exponential robots glob
  (task 7). (task 9)

- **2026-08-24** — `extractLinks` threw a `RangeError` on a fractional `maxLinks`
  (`links.length = 0.5`), breaking its documented totality. `positiveOr`/`nonNegativeOr`
  now floor to a whole number and treat anything that floors to `0` as out of range.
  Found by the options fuzz. (task 9)

- **2026-08-24** — Consequently `resolveCrawlOptions` REJECTS a fractional count
  (`concurrency`, `perHostConcurrency`, `maxQueued`, `maxDepth`, `maxPages`,
  `scope.maxUrlLength`, `extract.maxLinks`, `extract.maxAnchorText`, `robots.maxBytes`,
  every `traps.*`). Without it the two halves disagree in the worst direction:
  `extract: { maxLinks: 0.5 }` passed validation, failed `./extract`'s own range check,
  and came back as the default `10_000` — the opposite of the ask, with no error
  anywhere. Durations, delays and byte budgets stay fractional-friendly; half a
  millisecond is a coherent request, half a link is not. `Infinity` still passes
  everywhere. (task 9, touches task 4's file)

- **2026-08-24** — Timing regression guards are **growth-rate** measurements, not
  wall-clock ceilings, wherever the bug they guard is super-linear. The first spelling of
  the ampersand guard used a 2 000 ms budget and would have passed against the broken
  code (~0.9 s at 200k) — an absolute budget at one input size measures the machine, and
  the budget has to be loose enough not to be flaky. The guards now time two input sizes
  (best of three runs each) and assert the ratio: 4x the input is ~4x the time when
  linear and was ~18x when quadratic. Verified by re-running each guard against a
  reverted copy of the source. Same change applied to `giant.html`'s linearity step,
  which additionally has to pass `maxLinks: Infinity` — the default cap stopped the scan
  a third of the way in, so it was measuring a fraction of the document it claimed.
  (task 9)

- **2026-08-24** — The fuzz suite asserts **how many links its generators produce**, not
  only that nothing threw. Uniformly random bytes essentially never spell a tag: that
  generator yields exactly zero links, so its per-link well-formedness checks were dead
  while still looking like a 1 500-iteration fuzz. The markup generator now assembles
  tags (weighted toward `href`-bearing elements, with the raw-text elements kept rare
  because they swallow the rest of the document) and every generator carries a floor on
  its yield. (task 9)

- **2026-08-24** — Housekeeping the corpus forced two config files.
  `deno.json` gains `fmt.exclude: ["tests/fixtures/"]` — `deno fmt` really does rewrite
  the HTML fixtures (verified: it re-indents them), and a corpus whose entire value is
  "these exact bytes" must not be under a formatter whose treatment of malformed markup
  is undefined and version-dependent. A new `.gitattributes` marks the corpus `-text` so
  no checkout normalizes `robots/bom-crlf.txt`'s CRLFs out of existence. Separately, the
  raw NUL byte in three test sources is now written `\u0000`: git classified those files
  as binary, so their diffs were unreviewable. (task 9)

- **2026-08-24** — `hostsAreSameSite(a, b, opts)` joins `./url`'s public surface and
  `isSameSite` is redefined as `hostnameOf` × it. Scope evaluation compares one target
  against a set of seed _hostnames_ once per discovered link, and the alternatives were
  both bad: synthesising a `https://${host}/` string per seed per link, or copying
  `isSameSite`'s mode switch — including the monotone no-registrable-domain fallback,
  which is exactly the subtlety a copy would drift on. Comparison inputs are normalized
  defensively (lowercased, root label dropped) so a hostname out of a config file
  compares like one out of `URL.hostname`. (task 10, touches task 2's file)

- **2026-08-24** — `evaluateScope`'s context is wider than doc 02's sketch: it also takes
  `rel`, `nofollow`, `allowPrivateHosts` and `getRegistrableDomain`. The doc's own check
  order needs all four (steps 2, 5 and 7 are spelled in terms of them), and they are all
  pure — leaving them out would have pushed three of the seven synchronous checks back
  into the engine, which is the opposite of why this function exists. The accepted
  verdict also carries `checkOnly`, which the function has already computed and the
  engine would otherwise derive again. (task 10)

- **2026-08-24** — **`exclude` applies to every URL; `include` and `pathPrefix` only
  narrow the crawl's own site.** A deny-list must never be bypassable, but an allow-list
  that also filtered externals would silently kill `checkExternal`: nobody's external
  links start with your `pathPrefix`, so a broken-link check would check nothing and
  report a wall of `out-of-scope`. Doc 02 lists all three under one step without saying
  which side of the external gate they sit on; this is that call. (task 10)

- **2026-08-24** — An **empty string in `include`/`exclude` contributes nothing**.
  `href.includes("")` is `true`, so a stray empty entry — the classic split-an-env-var
  accident — would otherwise exclude the entire web, or disable an allow-list, with no
  error message. Same call `./extract` makes about an empty `Allow:` line (task 7).
  (task 10)

- **2026-08-24** — Two refinements to doc 02's `unsupported-type` step. It applies to
  every **document** rel (`page`, `canonical`, `next`, `prev`, `sitemap`), not only
  `page` — a `<link rel=next href=/x.zip>` is exactly as unfetchable — while `asset`,
  `iframe` and `alternate` stay exempt, because those sources are opt-in and a caller who
  turned them on asked for those URLs. And a **check-only external is exempt entirely**:
  the deny-list exists so a crawler does not download a 4 GB `.mkv` looking for links in
  it, and a `checkExternal` fetch retains no body, so the waste it guards against cannot
  happen — while the links most likely to be broken are precisely the big binaries.
  (task 10)

- **2026-08-24** — `evaluateScope` re-checks the scheme and rejects anything but
  `http:`/`https:` as `bad-scheme`, even though the engine has already normalized. The
  transport is HTTP whatever `normalize.allowSchemes` was widened to keep in the graph,
  so this is a transport fact rather than a duplicated policy — and it makes the function
  correct standalone, which is what makes it exhaustively testable. (task 10)

- **2026-08-24** — Memory frontier shape: a **min-heap per host** plus a never-shrinking
  pushed-URL set, an in-flight map and a maintained pending counter. `pop` has to claim
  the globally best item whose host is not currently excluded; one ordered queue would
  have to pop-and-stash past excluded hosts, while per-host heaps make exclusion a set
  lookup and the claim an O(#hosts) scan of heads. Two implementation choices worth
  writing down: items are **copied on push** (a caller mutating what it pushed must not
  reorder a heap it no longer owns — the `resolveCrawlOptions` array-copy precedent), and
  a **deferred head blocks its host** rather than being skipped over, which agrees with
  what `release(url, readyAt)` means (the engine is putting a host aside). (task 11)

- **2026-08-24** — The memory `VisitedStore` forces `hasBody: false` on the way out
  whatever the caller passed, and `add` **replaces** rather than merges. `hasBody` is the
  engine's permission to send `If-None-Match`, and a `304` is only useful when there is a
  stored body to re-extract links from — a memory store answering `true` would turn every
  unchanged page into a page with no links. Replacing rather than merging keeps a
  redirect intermediate's minimal `{crawledAt, status}` from resurrecting a field of an
  earlier, fuller record. (task 11)

- **2026-08-24** — `tests/mod.test.ts` now also imports through the **published**
  specifiers (`@marianmeres/crawler`, `/url`, `/extract`, `/stores`) and asserts they
  resolve to the same modules with the same surfaces. Doc 05 §6 asks for the standalone
  contract to be _proven_; the rest of the suite imports by relative path, which proves
  nothing about packaging. A subpath that is declared but does not resolve now fails a
  test instead of `deno publish`. (task 11, review carry-over from task 9)

- **2026-08-24** — The engine lands in three files, not doc 02's two: `channel.ts`
  (the bounded hand-off), `stats.ts` (counters + snapshots) and `dispatcher.ts` (the
  loop, the workers and link processing, plus everything `src/crawler.ts`'s two entry
  points delegate to). `stats.ts` is doc 02 item 6's file and arrives one task early
  because `PageContext.stats` and `CrawlReport.stats` are typed as a full `CrawlStats`
  — a `run()` that cannot fill them does not type-check. What item 6 (task 15) still
  owns is `safeEmit`, the call sites, and the throttled progress timer. (task 12)

- **2026-08-24** — What task 12 deliberately leaves INERT, so a reader of the code is
  not surprised: `options.events` (rank 15), `maxPages`/`maxDuration`/`maxTotalBytes`
  and their `stoppedBy` values (rank 16), traps (rank 17) and the whole robots gate
  including `X-Robots-Tag` and `nofollow` enforcement (rank 14 — `PageResult.robots` IS
  populated from `<meta name=robots>`, because doc 05 §3's `beforeExtract` test asserts
  meta-robots survives the two-pass split, but nothing acts on it yet). Live already:
  `maxDepth`, `maxQueued` → `queue-full`, `duplicate`, `user`, and every synchronous
  scope reason from task 10. `stoppedBy` currently ranges over
  `completed`/`stop`/`abort`. (task 12)

- **2026-08-24** — `Channel.relax()` exists to break a real deadlock, not for tidiness.
  `stop()` must _deliver_ the pages already in flight, so it cannot close the channel
  before they finish — but a worker parked on `push()` finishes only when the consumer
  takes a value, and the obvious consumer spelling is `await crawler.stop()` _inside_
  its own `for await` body, which never takes another. Graceful paths therefore drop the
  capacity bound first, drain, then close; the extra memory is bounded by `concurrency`
  results. The consumer-`break` path is the opposite and closes first, because there
  `stop()`'s contract is that in-flight results are recorded but never delivered.
  (task 12)

- **2026-08-24** — **Seeds bypass `include`/`pathPrefix`; `add()` does not.** Those two
  options narrow what a crawl _expands into_, and a seed is the instruction rather than
  a discovery — without this, `crawl("https://a.com/", { scope: { pathPrefix: "/docs" }})`
  fetches exactly nothing, which is nobody's intent. `exclude`, the scheme/length/
  private-host checks and (from task 14) robots still apply to seeds: a deny-list is
  never bypassable. `add()` is the deliberate opposite — doc 02 item 1 says a manual URL
  is "subject to the same scope checks as any link", so it gets the full pipeline,
  including the seed-host locality rule. (task 12)

- **2026-08-24** — Seed/`add()` leniency: a bare `example.com` or `localhost:8080/x`
  gets an `https://`. `normalizeUrl` refuses to invent a scheme by design (doc 01: link
  extraction must never do that) and explicitly defers seed leniency to the engine. The
  guard is that the authority has to _look_ like one — `/^[^\s/?#@:]+(:\d+)?$/` over
  the text before the first `/?#` — so `localhost:8080/x` is accepted while
  `mailto:a@b.com` stays rejected instead of silently becoming a crawl of `b.com` (the
  `@` would otherwise read as userinfo). (task 12)

- **2026-08-24** — `shouldVisit` runs **before** the frontier `push()` that detects
  duplicates, inverting doc 02's steps 11 and 12. `push()` is the only atomic dedup and
  it is destructive, so the doc's order would need either a `has()` on the store
  contract (an extra PostgreSQL round-trip per link) or an engine-side mirror of the
  frontier's dedup set — the exact duplication the PG store exists to avoid. The
  visible consequence is that the hook is consulted **per edge**, so a URL linked from
  ten pages asks ten times; that is consistent with its signature, which takes the
  `LinkRecord` and the `referrer`, not just a URL. The recorded reason is still
  `duplicate` for an already-queued target, because `push()` is what answers last.
  (task 12)

- **2026-08-24** — With `followCanonical: false` the canonical edge is recorded with
  `skipReason: "excluded"`. Doc 02 requires the edge in the graph and requires it not to
  become work, and the `SkipReason` union has no canonical-specific member; `"excluded"`
  is already the union's option-driven rejection (it is what an `include` miss reports),
  which is exactly what this is. Extending the public union for one flag was the
  alternative and was rejected as the larger change. (task 12)

- **2026-08-24** — `checkOnly` is **recomputed at claim time** from the URL rather than
  carried on the frontier item: it is a pure function of the host and the scope options,
  and `FrontierItem` has no room for engine flags (every field there is either dedup
  key, ordering, or something `PageResult` inherits). This is why `isOnSeedSite` is now
  exported from `src/engine/scope.ts` — the engine needs the same answer the scope
  pipeline gives, and re-deriving the monotone same-site rule by hand is precisely the
  copy task 10 warned against. (task 12, touches task 10's file)

- **2026-08-24** — A `priority` function that throws, or returns a non-number, warns
  once and falls back to depth ordering instead of failing the crawl. `priority` is not
  one of doc 02's data-producing hooks (whose throws legitimately fail a page) — it is a
  sort key, and killing a crawl over a sort key is wildly disproportionate to what one
  does. (task 12)

- **2026-08-24** — Every redirect hop **and** the final URL are marked visited with the
  minimal `{crawledAt, status}` record, so another referrer pointing at a hop — or at
  the destination — never re-fetches the same bytes. This is the case the memory
  `VisitedStore`'s replace-don't-merge rule was written for (task 11). Also settled
  here: `PageResult.ok` means "no error AND (2xx or 304)", so a hook or extraction that
  throws makes a 200 page not-ok, and a raw conditional `304` counts as
  success-unchanged exactly as doc 02 item 1 requires. (task 12)

- **2026-08-24** — The dispatcher naps a bounded 50 ms only in one situation: the
  frontier reports pending work, nothing is in flight, and no host is inside a
  politeness window. The engine's own deferrals are all host-scheduled and produce an
  exact wake-up time, so this can only be reached by a custom store that defers _items_
  via `release(url, readyAt)` — for which the engine has no wake-up time at all. Every
  other idle path parks on a promise a completion resolves, raced against a single
  `setTimeout`, per doc 02's no-busy-waiting requirement. (task 12)

- **2026-08-24** — **`findCloseTagIndex` ignored its own `limit`**, and it was the same
  bug as `decodeEntities` one level up: `html.indexOf("</", k)` takes no end argument,
  so it scanned to the end of the DOCUMENT and the window only got to reject the answer
  afterwards. `extractLinks` looks up anchor text once per `<a>`, so a page whose
  anchors are never closed cost O(links × document) — measured **47 s** of blocked event
  loop on 1.3 MB of markup, against 12 ms for the same page with its anchors closed. The
  scan is now a bounded `charCodeAt` loop, checked equivalent to the old one over 240 000
  differential comparisons; the windowed path got 16–70× faster and, more to the point,
  is now flat in document size. The cost is that the one unbounded caller (the raw-text
  skip) gives up `indexOf`'s SIMD search — ~85 ms instead of ~2 ms on a 16 MB document,
  once — which is worth one predictable code path in the function every link goes
  through. Found by the adversarial review of task 9, not by the fuzz suite: the suite's
  own "a 1M-character anchor body" step asserted this exact invariant and could not see
  it, because its single anchor is closed. Pinned now by a growth-rate test that fails at
  18× against the old code. (task 9, follow-up)

- **2026-08-24** — Three more test defects from the same review, each fixed and each
  worth naming because they are the failure modes a test suite hides behind:
  `script-noise.html`'s "a `<` that is arithmetic" step asserted a title that is parsed
  _before_ the `<script>` it claimed to be about (it now asserts the link list, which
  actually depends on the raw-text skip); `conflicting-precedence.txt`'s "an unmatched
  path is allowed" used `/plain`, which matches `/p` and is allowed for a completely
  different reason; and removing the `MAX_REGION_DEPTH` guard outright survived the whole
  suite, so the cap now has a boundary test (the 64th landmark counts, the 65th does
  not). (task 9, follow-up)

- **2026-08-24** — Doc 05 §3 lists five engine test files; three land now and two are
  **deferred to the ranks that make them writable**: `crawler-limits.test.ts` needs
  `maxPages`/`maxDuration`/`maxTotalBytes` (rank 16) and `crawler-events.test.ts` needs
  the event call sites (rank 15). The parts of that second file that are _not_ about
  events — `stop()` drains, `abort()`/`signal` cancel, `dispose()` — are engine
  lifecycle and are in `crawler.test.ts` now. `crawler-scope-robots.test.ts` lands with
  its scope, region and `beforeExtract` half; the robots half is rank 14. (task 13)

- **2026-08-24** — `SMALL_SITE` is doc 05 §3's twelve entries verbatim, and the
  region/`beforeExtract` suites use their own small `MiniSite`s rather than growing it.
  Those cases need landmark markup, `<div class="main">` soup and a `<base href>` — put
  on `SMALL_SITE` they would change the BFS order, the depth map and the dedupe counts
  that every other assertion in the package is written against. `FakePage` gained two
  fields doc 05 did not spell but its own text requires ("never sleeps and never throws
  unless a step is scripted to"): `delayMs` (signal-aware, so an abort test can cancel
  mid-flight) and `error`. (task 13)

- **2026-08-24** — Engine suites pass `robots: { respect: false }` explicitly, even
  while the gate does not exist. Two reasons: the assertions stay valid across rank 14
  instead of being rewritten by it, and an engine test that also depends on a robots
  verdict is testing two things at once. The default-on path is `crawler-scope-robots`'s
  job. (task 13)

- **2026-08-24** — **`maxDepth: 0` was rejected, and should not be.** Task 4's rule —
  every `> 0` knob rejects `0` rather than reading it as "unlimited" — was applied to
  `maxDepth` too, which made "crawl exactly these seeds, follow nothing" unexpressible
  except via `shouldVisit: () => false`. The rule's rationale does not survive contact
  with a _depth_: `0` is a page that gets crawled, so zero is the tightest limit rather
  than the absence of one. `maxDepth` is now the single count validated as `>= 0`. Found
  by the task-13 suite. (task 13, touches task 4's file)

- **2026-08-24** — A page is **counted after `onPage` has run**, not before. `onPage` is
  documented as running before the page is yielded and its throw FAILS the page, so
  whether the page lands in `done` or in `failed` is not settled until the hook has had
  its say — counting first meant a hook-failed page was reported as a success. The
  visible consequence is now documented on `PageContext.stats`: the page itself is not
  in that snapshot yet (it is still part of `inFlight`). Found by the task-13 suite.
  (task 13)

- **2026-08-24** — A seed and an `add()`ed URL are evaluated with
  `regionsPresent: false`. Without it, `scope.followRegions` rejected the seed itself as
  `out-of-region` — a seed has no landmark because it was never found in a document —
  and the crawl fetched literally nothing. Reusing the whole-document fallback says
  exactly the right thing ("this URL did not come from regioned markup") instead of
  special-casing the option away. Found by the task-13 suite. (task 13)

- **2026-08-24** — `stop()`/`abort()`/`dispose()` racing `run()`'s startup: shutdown
  could latch, drain and finalize _while_ `#start` was still enqueuing seeds, after
  which `#start` went on to set `dispatching = true` and launch the loop — resurrecting
  a crawl that had already reported its final `stoppedBy`. Startup is now a tracked
  promise that shutdown awaits, and `#start` returns without dispatching if a shutdown
  latched while it ran. Found by the task-13 suite (it deadlocked the run rather than
  failing an assertion, which is how the whole file came to be run one test at a time).
  (task 13)

## How to resume (for a fresh conversation)

1. Read this file + `00-overview-and-roadmap.md`.
2. Pick the next ⬜ task; open its source doc section for the verified detail.
3. Resolve that task's "Open questions" with the owner; record in the Decisions log.
4. Branch → implement → run the test suite → update this file → commit when the owner
   asks.
