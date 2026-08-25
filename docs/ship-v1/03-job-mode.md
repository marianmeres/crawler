<!--
GENERATED PLAN — @marianmeres/crawler, remaining v1 work (was docs/plan backlog ranks 28-34)
Produced 2026-08-25 by re-cutting docs/plan/PROGRESS.md's open backlog into the current
MULTISTEP_PROGRESS_FILESYSTEM_LAYOUT_INSTRUCTIONS.md + sprint/SPEC.md tracker format.
Claims re-verified against the working tree at commit cebf5d0. No code was changed.
-->

# `./steve` — crawls as steve jobs

> ONE CRAWL = ONE JOB. steve gives the crawl a durable queue entry, retry-with-backoff
> and a `find(uid)` status check; everything per-URL — live progress, pages, bodies, the
> link graph — lives in the crawler's own PG tables, because steve has no mid-run
> progress API. That asymmetry is the whole design, and three of these seven tasks are
> documentation precisely because the ways to get it wrong (a 5-minute reaper killing a
> healthy crawl, a worker with no crawl handler noop-completing the job) are silent.
>
> The full spec is [`../plan/04-steve-jobs-integration.md`](../plan/04-steve-jobs-integration.md).
> This sprint depends on the `./pg` sprint being finished: job mode always runs on PG
> stores, because retry-resume has nowhere else to resume from.
>
> steve is a **type-only** dependency — the consumer passes a live `Jobs` instance in.

## Summary

| # | Task | Value | Effort | Risk |
|---|------|-------|--------|------|
| T28 | `./steve` scaffold + serializable payload/result types | high | S | low |
| T29 | `createCrawlJobHandler` factory | high | M | med |
| T32 | AbortSignal wiring | high | S | med |
| T30 | Failure semantics + crash-resume on retry | high | M | med |
| T31 | Enqueue + status helpers | high | S | low |
| T33 | Reaper, listing-window and claiming guidance | high | S | low |
| T34 | Steve integration tests + e2e | high | M | low |

**The steve surface these tasks bind to** (so no task needs to read steve's source):

```ts
type JobHandler = (job: Job, signal?: AbortSignal) => unknown | Promise<unknown>;

interface Job {
	id: number; uid: string; type: string;
	payload: Record<string, unknown>;
	tenant_id: string | null;                 // null = global/un-scoped
	result: null | undefined | Record<string, unknown>;
	status: "pending" | "running" | "completed" | "failed" | "expired";
	attempts: number; max_attempts: number; max_attempt_duration_ms: number;
	created_at: Date; updated_at: Date; started_at: Date;   // started_at = FIRST attempt
	completed_at: Date; run_at: Date;
	backoff_strategy: "none" | "exp";
}

interface JobCreateOptions {
	max_attempts?: number;                    // default 3
	max_attempt_duration_ms?: number;         // default 0 = no limit, and NO signal
	backoff_strategy?: "none" | "exp";        // default "exp"
	run_at?: Date;
	tenant_id?: string | null;
}

// Jobs (instance, injected): create(type, payload, opts) · find(uid) · fetchAll(...)
// · start(n) · stop() · setHandler(type, handler) · onDoneFor(uid, cb) · resetHard()
```

## Tasks

### T28 — `./steve` module scaffold + serializable payload/result types

**What to build** — [`../plan/04-steve-jobs-integration.md`](../plan/04-steve-jobs-integration.md)
§1: `src/steve/mod.ts` + `src/steve/types.ts` with `CRAWL_JOB_TYPE`,
`SerializableCrawlOptions`, `SerializableScopeOptions`, `CrawlJobPayload` and
`CrawlJobResult`.

The binding rule: a steve payload is JSONB, so **functions can never ride in it**.
`fetcher`, `stores`, `events`, `signal`, `logger`, `onPage`, `onLink`, `shouldVisit`,
`priority`, `robots.fetch`, RegExp `normalize.stripParams`, RegExp `scope.include`/
`exclude` and `collect` are all excluded and configured code-side in T29's factory.
`persistBody` appears on the payload as a **boolean only** — its predicate form is a
`./pg` option, not a `CrawlOptions` key.

`CrawlJobResult` carries `crawlUid`, `stoppedBy`, final `stats` minus `byHost`, `attempt`
and `resumed` — never pages, never the graph, never bodies (owner decision 3).

**Done when** — `deno check` passes with `"./steve"` in the exports map and the
self-import entries, `tests/mod.test.ts` pins the new module's export list, and a
**type-level** assertion in `tests/steve-types.test.ts` proves no top-level property of
`SerializableCrawlOptions` is function-typed:
`{ [K in keyof T]: T[K] extends (...a: never) => unknown ? K : never }[keyof T]`
must be assignable to `never`. That assertion is what catches doc-02 drift when
`CrawlOptions` grows a new hook.

**Affected files** — `src/steve/mod.ts`, `src/steve/types.ts`, `deno.json` (exports +
imports: `"@marianmeres/steve": "jsr:@marianmeres/steve@^3.0.0"`),
`tests/steve-types.test.ts`, `tests/mod.test.ts`.

### T29 — `createCrawlJobHandler` factory

**What to build** — [`../plan/04-steve-jobs-integration.md`](../plan/04-steve-jobs-integration.md)
§6, the seven-step handler algorithm: validate the payload (unknown top-level keys warn
and are ignored, wrong-typed known keys throw); shallow-merge `baseOptions` under the
payload per top-level key; then **force** the non-negotiables — PG stores from `opts.db`,
the factory's `logger`, the injected-or-default fetcher, and
`collect: { pages: false, graph: false }` so nothing accumulates in memory; resolve or
create the crawl run keyed to `job.uid`; run; return the small summary; on a fatal error
mark the crawl row failed best-effort and **rethrow**; dispose in `finally` only what the
handler itself created.

Warn once (via `logger`) when the merged options carry none of `maxDuration`, `maxPages`
or `maxTotalBytes` — with steve's default `max_attempt_duration_ms: 0` there is no signal
either, so such a crawl can run forever.

One handler instance must be safe for concurrent invocations: no shared mutable state in
the closure except the once-flags for those warnings.

**Done when** — `tests/steve-handler.test.ts` passes by invoking the produced handler
**directly** with a hand-built `Job` (only `uid`, `attempts`, `payload`, `tenant_id` are
read): a crawl of the fixture site completes, `__crawler_page` holds its rows, the
returned `CrawlJobResult` round-trips through `JSON.stringify` and contains no `pages`,
`graph` or body-shaped key; a payload `maxPages` beats a larger `baseOptions.maxPages`;
an invalid payload throws before any row is written; the missing-budget warning fires
exactly once across two invocations.

**Affected files** — `src/steve/handler.ts`, `src/steve/mod.ts`,
`tests/steve-handler.test.ts`.

### T32 — Cancellation: AbortSignal wiring

**What to build** — [`../plan/04-steve-jobs-integration.md`](../plan/04-steve-jobs-integration.md)
§5. `signal?.throwIfAborted()` first, then forward steve's signal as
`CrawlOptions.signal` — which the engine already treats as a hard abort that cancels
in-flight fetches. Explicitly **not** `addEventListener("abort", () => crawler.stop())`:
`stop()` drains, and once steve's signal has fired the attempt is already lost, so
draining is zombie work racing the retry.

**Done when** — a test in `tests/steve-handler.test.ts` invokes the handler with an
`AbortController`, aborts after the first fixture page completes (hit counter), and
asserts the invocation ends promptly, that no further fixture requests arrive after the
abort, and that the pages already persisted are still in `__crawler_page` — i.e. the
run is resumable rather than rolled back.

**Affected files** — `src/steve/handler.ts`, `tests/steve-handler.test.ts`.

### T30 — Failure semantics + crash-resume on retry

**What to build** — [`../plan/04-steve-jobs-integration.md`](../plan/04-steve-jobs-integration.md)
§7: the resume path inside the handler, plus the error-taxonomy table as JSDoc on the
factory. Page-level failures never throw — they are rows in `__crawler_page` and counters
in the summary, and the job **completes**. Only invalid payloads, store/DB errors and
fetcher construction failures throw, which is what steve retries.

Resume: target run = `payload.crawlUid` ?? `getCrawlByJobUid(job.uid)` (meaningful when
`job.attempts > 1`). A run already `completed`/`stopped` returns its stored summary
idempotently with `resumed: true` and does no crawl work — that absorbs the zombie case
where a timed-out background handler finished after steve recorded the timeout. A
`running` or `failed` run resumes: re-point `job_uid`, re-claim `in_flight` frontier rows
(T22's `openCrawl` does this), keep visited/pages/links/archive, re-push the seeds (the
frontier's `ON CONFLICT` makes that a no-op), and call `recomputeStats` so `onProgress`
deltas start from truth rather than the stale pre-crash snapshot.

**Done when** — `tests/steve-resume.test.ts` passes: invoke the handler with
`attempts: 1` and abort mid-crawl; invoke again with `attempts: 2`, the same `uid` and no
signal — the crawl row is **reused**, the fixture's hit counter shows the already-fetched
pages were not re-fetched, and the run completes; a third invocation with `attempts: 3`
on the now-completed run returns the stored summary with `resumed: true` and zero new
fetches.

**Affected files** — `src/steve/handler.ts`, `tests/steve-resume.test.ts`.

### T31 — Enqueue + status helpers

**What to build** — [`../plan/04-steve-jobs-integration.md`](../plan/04-steve-jobs-integration.md)
§2: `startCrawlJob(jobs, seeds, options?, jobOptions?)` — normalize seeds to an array,
**throw synchronously** on empty or non-string input (an invalid payload would otherwise
burn all `max_attempts` for nothing), build the payload, pass `JobCreateOptions` through
untouched, return `{ uid }`. Plus the documented polling pattern: coarse status from
`jobs.find(uid)`, fine progress from `getCrawlByJobUid(uid)` and `__crawler_page`.

**Decided 2026-08-25** — no `resumeCrawlJob()` helper in v1 (owner call). The recovery
path is the documented two-step: look the crawl row up by `job_uid`, re-enqueue with
`{ crawlUid }`. T33 writes it down.

**Done when** — `tests/steve-start.test.ts` passes: an empty/non-string seed list throws
before any DB call (assert with a `Jobs` double whose `create` records invocations);
a valid call creates exactly one job of type `CRAWL_JOB_TYPE` whose payload round-trips
through `JSON.stringify` unchanged; `type`, `tenant_id`, `run_at` and `max_attempts`
reach `jobs.create` verbatim.

**Affected files** — `src/steve/start.ts`, `src/steve/mod.ts`,
`tests/steve-start.test.ts`.

### T33 — Reaper, listing-window and claiming guidance

**What to build** — [`../plan/04-steve-jobs-integration.md`](../plan/04-steve-jobs-integration.md)
§3, §4 and §8: the JSDoc and README material that prevents job mode's two silent
production failures.

1. **The reaper.** steve's opt-in `autoCleanup` expires any job `running` longer than
   `maxAllowedRunDurationMinutes` — **default 5** — and `expired` is terminal, never
   retried. `started_at` is preserved across retries, so the window must cover the whole
   retry story: `maxAllowedRunDurationMinutes >= max_attempts * ceil(maxDuration / 60_000) + 15`,
   or leave autoCleanup off and call `jobs.cleanup(N)` with a crawl-aware `N`.
2. **Type-blind claiming.** steve claims by status and `run_at` only — any started `Jobs`
   instance on the same `tablePrefix` will claim `"crawl"` jobs, and a worker with no
   handler for the type noop-completes it: the crawl silently never runs and the job
   reads `completed`. Recommend a dedicated `tablePrefix`; otherwise every worker on the
   prefix must register the crawl handler.
3. **The 30-minute listing window** on `fetchAll`, and the corollary that real crawl
   history lives in `__crawler_crawl`, not in steve rows.
4. The recovery snippet for a reaped job, and the worker/enqueue/poll recipe.

This is documentation; there is nothing to enforce at runtime, since the factory cannot
see the consumer's `Jobs` configuration. Do not add a runtime probe.

**Done when** — `createCrawlJobHandler` and `startCrawlJob` carry the guidance in JSDoc,
the README's Job mode section contains the reaper call-out with the formula, the claiming
rules and the recovery snippet, and `deno doc` (or `deno check`) is clean. The README
section is written here; T37 folds it into the finished document rather than rewriting
it.

**Affected files** — `src/steve/handler.ts`, `src/steve/start.ts`, `src/steve/mod.ts`,
`README.md`.

### T34 — Steve integration tests + e2e

**What to build** — [`../plan/04-steve-jobs-integration.md`](../plan/04-steve-jobs-integration.md)
§9 and [`../plan/05-testing-docs-release.md`](../plan/05-testing-docs-release.md) §7: the
one test that drives a **real** `Jobs` instance rather than invoking the handler
directly. `Jobs` on the `"_test_"` prefix with `pollTimeoutMs: 100` and
`gracefulSigterm: false`, the crawl handler registered, `resetHard()` on both schemas,
`startCrawlJob`, `jobs.start(1)`, then poll the crawl row until terminal.

**Done when** — `tests/steve-e2e.test.ts` passes with `TEST_PG_*` set: the steve job ends
`completed`; its `result` parses as a `CrawlJobResult`, is small, and contains no page
body text (assert explicitly — this is decision 3's only executable check);
`__crawler_page` matches the fixture's reachable set; the crawl row carries final stats
and the `job_uid` back-reference. Teardown stops the worker and closes the pool in
`finally`. Assert terminal state only — never an intermediate `running` on a fixed
schedule, since the fixture crawl finishes in milliseconds.

**Affected files** — `tests/steve-e2e.test.ts`.
