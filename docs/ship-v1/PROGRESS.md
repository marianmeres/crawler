# Implementation Progress — @marianmeres/crawler v1

<!-- tracker: v1 -->

Living tracker for acting on [`00-overview-and-roadmap.md`](./00-overview-and-roadmap.md).
A fresh conversation should read this file first, then the task's `NN-*.md` section — which
carries the **Done when** criterion and links to the deep spec in `../plan/`.

**Status legend:** ⬜ ready · 🚧 in progress · ⏸️ blocked/awaiting decision · 🔒 human-only ·
✅ done · ⏭️ deferred

> Convention: one branch per sprint, one commit per task. Each task resolves its source doc's
> open questions first (they are all closed — see the Decisions log), then implement → verify
> → tick here. Ids continue the original plan: backlog ranks 15-38 kept their numbers as
> T15-T38, so every "(task NN)" reference in [`../plan/PROGRESS.md`](../plan/PROGRESS.md)
> still resolves. T39 is the only new task.

## Running this tracker

Four sprint sections, run one at a time from the repository root — e.g.
`sprint docs/ship-v1 --dry-run` first, then for real. Five things are worth knowing before
the first run:

1. **One sprint per branch, cut from `master`.** The driver switches to the branch each
   section declares, but only from a default branch with a clean tree. So merge a finished
   sprint back to `master` before starting the next one, or the driver refuses rather than
   guessing whether the new sprint should sit on the old one's work.
2. **The driver takes the last flags declared in this file.** Today's implementation reads
   one set for the whole file, so there is exactly one such line, under sprint 2. Override
   per run on the command line.
3. **Sprints 3 and 4 need a live PostgreSQL** and the `TEST_PG_*` variables in `.env`. Their
   suites are `ignore`-gated, so without a database they *skip* rather than fail — nine tasks
   could land "green" without a statement ever reaching a server. Each PG task's Done when is
   written to make that visible; check the DB is up before starting.
4. **The driver's agent cannot read sibling repositories** (`--setting-sources project` drops
   the user-level directory grants). Everything a task needs from steve, cron or page-fetcher
   is inlined into the task docs for that reason. If you would rather grant it, add
   `.claude/settings.json` with `permissions.additionalDirectories` pointing at
   `/Users/mm/projects/@marianmeres/{steve,cron,page-fetcher,npmbuild}`.
5. **Publishing is not in the tables.** The final `deno task rp` is irreversible and
   outward-facing; T38 stops at the checklist and the dry runs. (It would be a 🔒 row, but the
   current driver's parser rejects that icon — it would refuse the whole file.)

## Sprint 2 — engine completion (events, budgets, traps, sitemaps)

Branch: `sprint-02-engine`
Options: --max-tasks 50 --budget 45 --task-budget 15 --max-turns 200 --task-timeout 3600 --model claude-opus-5 --effort xhigh
Verify: deno task test

| Status | ID | Deps | Task | Source | Commit |
|--------|----|------|------|--------|--------|
| ✅ | T15 | — | Events, `safeEmit`, throttled progress | [01](./01-engine-completion.md) T15 | da835bb |
| ✅ | T16 | — | Budgets and `stoppedBy` semantics | [01](./01-engine-completion.md) T16 | 6175335 |
| ✅ | T17 | — | Trap detection | [01](./01-engine-completion.md) T17 | 2ade397 |
| ✅ | T18 | — | `parseSitemap` + robots `Sitemap:` seeding | [01](./01-engine-completion.md) T18 | e1b4a1e |
| ✅ | T39 | — | Mask userinfo credentials in every message | [01](./01-engine-completion.md) T39 | c410fb6 |

No database, no new submodule, no external package: this whole sprint runs against the fake
transport from task 13. Three of the five tasks wire options that are already declared,
validated and pinned by `tests/options.test.ts` — implement what they promise, do not
redesign them.

## Sprint 3 — `./pg` persistence

Branch: `sprint-03-pg`

| Status | ID | Deps | Task | Source | Commit |
|--------|----|------|------|--------|--------|
| ✅ | T21 | — | PG test harness, env and gating | [02](./02-pg-persistence.md) T21 | 99c27c6 |
| ✅ | T19 | T21 | Schema DDL — the 5 tables | [02](./02-pg-persistence.md) T19 | a92b1c3 |
| ✅ | T20 | T19 | `createCrawlerPg` factory + lifecycle | [02](./02-pg-persistence.md) T20 | 3b311c0 |
| ✅ | T22 | T20 | `PgFrontierStore` / `PgVisitedStore` | [02](./02-pg-persistence.md) T22 | b158e4e |
| ✅ | T23 | T22 | `persistPage` writers | [02](./02-pg-persistence.md) T23 | 6cddfd7 |
| ✅ | T24 | T20 | Live progress writer | [02](./02-pg-persistence.md) T24 | 9b54f80 |
| ✅ | T25 | T23 | Consumer query / reporting API | [02](./02-pg-persistence.md) T25 | 3b04d1b |
| ✅ | T26 | T23 T25 | Incremental re-crawl (validators, 304 path) | [02](./02-pg-persistence.md) T26 | 86bc35e |
| ✅ | T27 | T22 T23 T25 | PG integration tests | [02](./02-pg-persistence.md) T27 | 4394330 |

The harness runs first even though the source doc's build order starts at the schema: the
schema's Done when is a test, and there is nothing to run one with until T21 lands.

## Sprint 4 — `./steve` job mode

Branch: `sprint-04-steve`

| Status | ID | Deps | Task | Source | Commit |
|--------|----|------|------|--------|--------|
| ✅ | T28 | — | `./steve` scaffold + payload/result types | [03](./03-job-mode.md) T28 | 735b4f6 |
| ✅ | T29 | T20 T22 T23 T28 | `createCrawlJobHandler` factory | [03](./03-job-mode.md) T29 | d54b61b |
| ✅ | T32 | T29 | AbortSignal wiring | [03](./03-job-mode.md) T32 | — |
| ✅ | T30 | T25 T29 | Failure semantics + crash-resume on retry | [03](./03-job-mode.md) T30 | — |
| ✅ | T31 | T28 | Enqueue + status helpers | [03](./03-job-mode.md) T31 | — |
| ✅ | T33 | T29 T31 | Reaper, listing-window and claiming guidance | [03](./03-job-mode.md) T33 | — |
| ✅ | T34 | T29 T30 T31 | Steve integration tests + e2e | [03](./03-job-mode.md) T34 | — |

Job mode always runs on PG stores, so this sprint cannot start before sprint 3 is merged.
T33 is documentation, and it is documentation on purpose: both failures it prevents — a
5-minute reaper expiring a healthy crawl, a worker noop-completing a crawl job — are
invisible at runtime and cannot be enforced from inside a handler factory.

## Sprint 5 — packaging, recipes, docs, release

Branch: `sprint-05-release`

| Status | ID | Deps | Task | Source | Commit |
|--------|----|------|------|--------|--------|
| ✅ | T35 | T20 T28 | npm build: entry points + real dependency list | [04](./04-packaging-docs-release.md) T35 | — |
| ✅ | T36 | T26 T29 | Recipes / examples dir (6 recipes) | [04](./04-packaging-docs-release.md) T36 | — |
| ⬜ | T37 | T33 T36 | README + AGENTS.md + `.env.example` | [04](./04-packaging-docs-release.md) T37 | — |
| ⬜ | T38 | T35 T37 | Release checklist + dry runs | [04](./04-packaging-docs-release.md) T38 | — |

T38 ends at the checklist and the dry runs. The publish itself (`deno task rp` → JSR + npm)
is yours, not the driver's.

## Decisions log

Everything below was settled on 2026-08-25, closing the eight open questions the previous
tracker carried. Four were the owner's call; four were engineering calls made while
re-cutting the plan, each recorded with its reasoning so it can be overturned knowingly.

- **2026-08-25** — [owner] **URLs with userinfo credentials stay verbatim through the whole
  pipeline** — fetch, frontier key, `PageResult.url`, and the PG rows. Stripping or refusing
  them was rejected by the owner on the grounds that such URLs can legitimately need
  crawling. Redacting only on the way into PG was rejected here as well: the PG frontier is
  the durable resume queue, so a redacted URL there comes back unfetchable after a crash, and
  a mixed representation (real in the frontier, masked in the archive) buys no security
  boundary — it is the same database — while adding a collision corner between two passwords
  for one user and path. The counterpart is that credentials must never reach a message: T39
  adds `maskUserinfo()` and applies it at every log/error site, and T37 documents that
  fetcher headers are the preferred way to authenticate. (T39, T23, T37)
- **2026-08-25** — [owner] **`pruneUrls({ olderThan?, host? })` ships in v1.** The archive is
  the one table that grows forever. It is the only data-destroying method in the package, so
  it requires at least one filter, returns the deleted count, and carries the JSDoc warning
  that a pruned body makes the next re-crawl of that URL unconditional. (T25)
- **2026-08-25** — [owner] **The body archive stays `(tenant_id, url)`-keyed; two tenants
  crawling one site store the bytes twice.** Tenant isolation stays absolute — deleting a
  tenant deletes its bodies and no cross-tenant read path exists — which is worth more than
  the storage in the rare overlap case. Chosen, not inherited. (T19)
- **2026-08-25** — [owner] **No `resumeCrawlJob()` helper in v1.** Recovery from a reaped job
  is the documented two-step: look the crawl row up by `job_uid`, re-enqueue with
  `{ crawlUid }`. Doc 04's own lean; add the helper when a consumer asks for it. (T31, T33)
- **2026-08-25** — The PG frontier `pop` keeps `host <> ALL($2::text[])`; **the host-status
  side table stays unbuilt** until profiling asks for it. Doc 02 left this to doc 03 and doc
  03 left it to implementation. The exclusion list is bounded by the crawl's *active* host
  count rather than the site's, and the pop index makes the residual filter cheap — so the
  side table would be a second source of truth for a cost nobody has measured. (T22)
- **2026-08-25** — **PG-gated tests skip silently** (`ignore: !TEST_PG_DATABASE`), with the
  requirement documented in AGENTS.md rather than printed per run. steve and cron offer no
  precedent — they fail hard — but this package is memory-first and its suite must stay green
  without a database. The cost is that a whole sprint can pass without touching PG, which is
  why each PG task's Done when asserts a non-zero PG test count instead. (T21, T27, T37)
- **2026-08-25** — **The release checklist lives at the bottom of `AGENTS.md`**, not in a
  separate `docs/RELEASING.md` — doc 05's own preference, and it puts the checklist where the
  agent-facing invariants already are. (T38)
- **2026-08-25** — **`@marianmeres/steve` stays an optional npm peer only if the emitted
  `.d.ts` references it.** Decided as a rule rather than a guess, because the answer is
  observable at build time: inspect `.npm-dist/dist/steve.d.ts` after `deno task npm:build`
  and drop the peer rather than declare a dead one. (T35)
- **2026-08-25** — Doc 04's open question 1 is closed by doc 03's own naming: the job-mode
  bridge is **`getCrawlByJobUid(jobUid)`** and the stats baseline is **`recomputeStats(uid)`**,
  both on `CrawlerPg`. They are not optional parts of T25 — T30 cannot resume without them.
  (T25, T30)
- **2026-08-25** — **`VisitedStore` gains an optional `getBody?(url)`.** Doc 03 §8 assigns the
  304 re-extraction to "doc 02/04 wiring" and neither doc owns it; verified in the tree, a 304
  arrives bodyless and `dispatcher.ts:644` extracts links only where there is a body, so an
  incremental re-crawl would traverse nothing. An optional store method is the store-agnostic
  way to reach the archived bytes, leaves the memory stores untouched, and is only ever called
  where `hasBody` is already true. This is the sprint's one public-contract change. (T26)
- **2026-08-25** — This directory re-cuts the open half of `../plan/PROGRESS.md` into the
  current tracker format; **`../plan/` stays authoritative for the specs** and unedited, and
  its completed sprints stay its own record. Task ids were preserved rather than renumbered,
  so the old decisions log's "(task NN)" references keep resolving.

## How to resume (for a fresh conversation)

1. Read this file + [`00-overview-and-roadmap.md`](./00-overview-and-roadmap.md).
2. Pick the first ⬜ task whose `Deps` are all ✅ (or the `T##` you were given); open its
   section in the `NN-*.md` doc named in the Source column for the detail and its **Done
   when** criterion, then the `../plan/` section that doc points at for the full spec.
3. Check the finding still holds against the current code before writing anything — the
   premise notes in each task ("Where it stands") are what to re-verify. If the tree has
   moved on, say so and stop.
4. Branch → implement → run `deno task test` → update this file → commit when the owner asks.
