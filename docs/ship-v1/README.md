# Ship v1 — @marianmeres/crawler

The still-open half of [`../plan/`](../plan/), re-cut on 2026-08-25 into the current
`MULTISTEP_PROGRESS_FILESYSTEM_LAYOUT_INSTRUCTIONS.md` + `sprint/SPEC.md` tracker format so
the remaining 25 tasks can be driven by the sprint script. Planning artifact — no code was
changed; every premise was re-verified against the working tree at `cebf5d0`.

**Start here:** [`00-overview-and-roadmap.md`](./00-overview-and-roadmap.md).
**Execution status lives in:** [`PROGRESS.md`](./PROGRESS.md).

`../plan/` is unchanged and stays authoritative for the specs: docs `01`-`05` there hold the
verified detail, the SQL and the type shapes, and its `PROGRESS.md` remains the record of the
14 tasks already done. The docs here add what that format needs and those docs lack — a
**Done when** per task, an affected-file list, the dependency graph, and the decisions that
closed the eight open questions.

## Documents

| # | Doc | Scope | Headline |
|---|-----|-------|----------|
| 00 | [overview-and-roadmap](./00-overview-and-roadmap.md) | synthesis + sequencing | Four sprints; the split is a dependency fact, not a preference |
| 01 | [engine-completion](./01-engine-completion.md) | T15-T18, T39 | Three of five tasks wire options that already exist and do nothing |
| 02 | [pg-persistence](./02-pg-persistence.md) | T19-T27 | Nine tasks, a strict chain, and untestable without a live PostgreSQL |
| 03 | [job-mode](./03-job-mode.md) | T28-T34 | Three of seven are documentation, because job mode's failure modes are silent |
| 04 | [packaging-docs-release](./04-packaging-docs-release.md) | T35-T38 | The npm build still declares zero dependencies; every node consumer would break |

## How it was produced

Read the old tracker and the five source docs, re-verified each remaining item against the
current tree (which moved the 304-traversal gap from "somebody's wiring" to an owned task),
collected the eight open questions into one sitting with the owner, then wrote one task brief
per row with an observable Done when.

> Nothing here is open. Every question the old tracker carried is answered in `PROGRESS.md`'s
> Decisions log — four by the owner, four as engineering calls recorded with their reasoning.
