# Implementation Progress — @marianmeres/crawler

Living tracker for acting on [`00-overview-and-roadmap.md`](./00-overview-and-roadmap.md).
A fresh conversation should read this file first, then the relevant `NN-*.md` section.

**Status legend:** ⬜ not started · 🚧 in progress · ⏸️ blocked/awaiting decision · ✅ done · ⏭️ deferred

> Convention: one branch per sprint, one commit per task. Each task resolves its source
> doc's "Open questions" first (record in the Decisions log), then implement → test →
> tick here. NOTE: the repo has no commits yet — EXECUTE step zero is committing the
> scaffold + this plan on `master`, then branching.

## First sprint (foundations — normalize semantics + contracts + packaging)

Branch: `sprint-01-foundations`

| # | Task | Source | Status | Commit |
|---|------|--------|--------|--------|
| 1 | `normalizeUrl` pipeline + `NormalizeOptions` | [01](./01-url-and-extraction.md) #3 | ✅ | — |
| 2 | `isSameSite` + registrable-domain heuristic + `classifyLink` | [01](./01-url-and-extraction.md) #1 | ✅ | — |
| 3 | `./url` unit-test corpora (incl. idempotency property test) | [01](./01-url-and-extraction.md) #5 | ⬜ | — |
| 4 | Public API surface: all types + `crawl`/`createCrawler` shells | [02](./02-crawl-engine.md) #1 | ⬜ | — |
| 5 | deno.json: exports map, imports, publish exclude, test task | [05](./05-testing-docs-release.md) #1 | ⬜ | — |

## Backlog (ranked, post-sprint)

| Rank | Task | Source | Status |
|------|------|--------|--------|
| 6 | `extractLinks` tokenizer + `extractTitle` + `_html.ts` scanner | [01](./01-url-and-extraction.md) #6 | ⬜ |
| 7 | `parseRobotsTxt` + wildcard matcher | [01](./01-url-and-extraction.md) #4 | ⬜ |
| 8 | `parseMetaRobots` + `parseXRobotsTag` | [01](./01-url-and-extraction.md) #2 | ⬜ |
| 9 | `./extract` fixture corpora + never-throws fuzz | [01](./01-url-and-extraction.md) #5 | ⬜ |
| 10 | Scope evaluation + `SkipReason` + private-host guard | [02](./02-crawl-engine.md) #2 | ⬜ |
| 11 | `FrontierStore`/`VisitedStore` interfaces + memory impls | [02](./02-crawl-engine.md) #3 | ⬜ |
| 12 | Worker pool, politeness, streaming `run()` | [02](./02-crawl-engine.md) #5 | ⬜ |
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
- **2026-08-24** — Design-sketch deviations (synthesis, per verified constraints):
  default fetcher is the HTTP adapter (browser drivers are injected, never bundled);
  `checkpoint()`/`checkpointEvery` dropped; SQLite dropped; `maxTotalBytes` rename;
  robots 5xx = disallow-all; same-site via heuristic + injectable PSL override; sketch
  §13 open questions adopted as suggested (canonical recorded, redirect-as-attribute,
  nearest-seed depth, pluggable priority, skips-as-events).

## How to resume (for a fresh conversation)

1. Read this file + `00-overview-and-roadmap.md`.
2. Pick the next ⬜ task; open its source doc section for the verified detail.
3. Resolve that task's "Open questions" with the owner; record in the Decisions log.
4. Branch → implement → run the test suite → update this file → commit when the owner
   asks.
