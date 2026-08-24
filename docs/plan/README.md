# Implementation Plan — @marianmeres/crawler

This directory holds the full implementation plan for the new `@marianmeres/crawler`
package, produced 2026-08-24 from the design sketch (`tmp/crawler-DESIGN.md`) plus an
owner interview. It is a planning artifact — no code was changed; every ecosystem claim
was verified against the real package sources (page-fetcher v0.4.0, steve v3.0.0,
cron v3.2.0, clog v3.21.0).

**Start here:** [`00-overview-and-roadmap.md`](./00-overview-and-roadmap.md).
**Execution status lives in:** [`PROGRESS.md`](./PROGRESS.md).

## Documents

| # | Doc | Scope | Headline finding |
|---|-----|-------|------------------|
| 00 | [overview-and-roadmap](./00-overview-and-roadmap.md) | synthesis + roadmap | Layered architecture: memory-default engine, `./pg` body archive, `./steve` one-crawl-one-job binding |
| 01 | [url-and-extraction](./01-url-and-extraction.md) | `./url`, `./extract` pure submodules | Greenfield by necessity (verified ecosystem gap); WHATWG-URL-based normalize + a shared no-DOM tokenizer |
| 02 | [crawl-engine](./02-crawl-engine.md) | core loop + public API | One claim/ack `pop({excludeHosts})` store contract lets PG drop in without engine changes |
| 03 | [pg-persistence](./03-pg-persistence.md) | `./pg` schema, stores, query API | Latest-per-URL body archive + 4 per-run tables; steve/cron conventions copied exactly |
| 04 | [steve-jobs-integration](./04-steve-jobs-integration.md) | `./steve` job mode | One crawl = one job with PG crash-resume; steve's 5-min reaper default and 30-min listing window documented loudly |
| 05 | [testing-docs-release](./05-testing-docs-release.md) | tests, docs, packaging | The scaffold ships broken as-is (no publish exclude, zero npm runtime deps) — packaging is a day-one fix |

## How it was produced

Parallel research agents over the ecosystem packages → owner interview (modes, body
storage, steve granularity, tenancy) → one writer per dimension → adversarial verifier
per doc (citation re-checks, DRY deletion, backbone consistency) → cross-doc
reconciliation + synthesis.

> Nothing here is decided beyond the owner decisions recorded in the docs and
> `PROGRESS.md`. Each doc's "Open questions / decisions needed" lists what still needs
> your call.
