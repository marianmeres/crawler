<!--
GENERATED ANALYSIS — @marianmeres/crawler implementation plan
Produced 2026-08-24 by multi-agent research -> adversarial verify -> synthesize.
Claims verified against ecosystem package working trees (page-fetcher v0.4.0, steve v3.0.0,
cron v3.2.0, clog v3.21.0). The crawler repo itself is a pre-first-commit scaffold.
Planning artifact; no code was changed.
-->

# Job Mode (./steve) — Crawls as steve Jobs

> The `./steve` submodule turns a whole crawl into ONE steve job: a handler factory the
> consumer registers under a `"crawl"` job type, plus an enqueue helper. steve gives the
> crawl a durable queue entry, retry-with-backoff on thrown errors, and a `find(uid)`
> status check — nothing more. Everything per-URL (live progress, pages, bodies, the link
> graph) lives in the crawler's own PG tables and is queried through `./pg`.
>
> The single most important takeaway: **steve rows are queue plumbing, not crawl data**.
> steve has no mid-run progress API, its `fetchAll` listing defaults to a 30-minute
> window, and its reaper — when enabled with defaults — expires any job running longer
> than 5 minutes. A crawl that outlives 5 minutes is the normal case, so the reaper
> guidance must be loud, in JSDoc and README, not a footnote.
>
> Headline recommendation: implement the handler factory so that the crawl run is keyed
> to the job (`__crawler_crawl.job_uid = job.uid`) and every retry resumes from PG state
> (re-claim `in_flight` frontier rows, keep visited). That one design choice makes
> steve's retry safe, makes reaped/expired jobs manually resumable via a payload
> `crawlUid`, and keeps the completion result a small JSON summary — never bodies.
>
> The submodule imports steve **types only** (`import type { Jobs, JobHandler, ... }`);
> the consumer passes a live `Jobs` instance in. No runtime steve dependency, exactly
> like the `pg` convention (backbone decisions 8/15).

## Summary of work items

| # | Work item | Value | Effort | Risk |
|---|-----------|-------|--------|------|
| 1 | `./steve` module scaffold + serializable payload/result types | high | S | low |
| 2 | Enqueue + status helpers (`startCrawlJob`, polling pattern) | high | S | low |
| 3 | Reaper & listing-window guidance (LOUD) | high | S | low |
| 4 | Type-blind claiming — deployment guidance | high | S | low |
| 5 | Cancellation: AbortSignal wiring | high | S | med |
| 6 | `createCrawlJobHandler` factory | high | M | med |
| 7 | Failure semantics + crash-resume on retry | high | M | med |
| 8 | Job-mode recipe + recurring re-crawl reference | high | M | low |
| 9 | Integration tests (`./steve` against real PG + local HTTP fixture) | high | M | low |

## Work items (detailed)

### 1. `./steve` module scaffold + serializable payload/result types

**What & why**
Create the `./steve` entry point and nail down the data contracts: what a crawl-job
payload IS and what a completed job's `result` JSONB contains. The critical rule to spell
in types and JSDoc: a steve payload is `Record<string, unknown>` persisted as JSONB
(steve/src/steve/jobs.ts:140, create at jobs.ts:752-757), so **functions can never ride
in it**. Hooks (`onPage`, `shouldVisit`, `onLink`), `events`, `fetcher`, custom `stores`,
`signal`, `logger`, RegExp patterns (scope/normalize) and the `robots.fetch` transport
override are configured code-side in the factory (`baseOptions`, work item 6); the
predicate form of `persistBody` is code-side too, on the factory's `pg` options (doc 03's
`CrawlerPgOptions.persistBody` — it is NOT a `CrawlOptions` key). The payload carries the
data-only subset: budgets, politeness numbers, string scope patterns, toggles.

**Evidence / reuse**
- steve payload type + serialization: jobs.ts:140 (`payload: Record<string, unknown>`),
  job/_handle-success.ts:15-23 (`JSON.stringify(result ?? {})` on completion).
- Owner decision 3: bodies never in steve result JSONB; steve rows get listed through a
  default 30-minute window (job/_find.ts:50) and cleaned up — plumbing, not archive.
- Design sketch options shape: tmp/crawler-DESIGN.md:109-137 (`CrawlOptions`), :131-134
  (the function-typed hooks that must be excluded).
- Type-only dependency precedent: page-fetcher re-exports clog's `Logger` type-only
  (page-fetcher/src/types.ts:12-22); crawler does the same (decision 7); steve/pg imports
  are type-only (decision 15).

**Spec**
```ts
// src/steve/types.ts (re-exported from src/steve/mod.ts)
import type { Job, JobCreateOptions, JobHandler, Jobs } from "@marianmeres/steve";
import type {
	CrawlOptions, CrawlReport, CrawlStats, NormalizeOptions, RobotsOptions, ScopeOptions,
} from "../mod.ts";

/** Default job type the crawl handler registers under. */
export const CRAWL_JOB_TYPE = "crawl";

/** ScopeOptions minus RegExp: payloads travel as JSONB, so patterns are strings only. */
export type SerializableScopeOptions = Omit<ScopeOptions, "include" | "exclude"> & {
	include?: string[];
	exclude?: string[];
};

/**
 * The JSON-serializable subset of CrawlOptions — the ONLY thing a job payload may
 * carry. Everything function-, store-, fetcher-, signal- or event-typed is excluded
 * and must be configured code-side via createCrawlJobHandler({ baseOptions }).
 * Union-typed options keep only their data arm (e.g. persistBody: boolean, never
 * the predicate).
 */
export type SerializableCrawlOptions = Omit<
	CrawlOptions,
	// exact key list synced to doc 02's final CrawlOptions; the RULE is binding:
	"fetcher" | "stores" | "events" | "signal" | "logger"
	| "onPage" | "onLink" | "shouldVisit" | "priority"
	| "scope" | "robots" | "normalize" | "collect"
> & {
	scope?: SerializableScopeOptions;
	/** RobotsOptions minus its FetchFn transport override — that stays code-side. */
	robots?: Omit<RobotsOptions, "fetch">;
	/** NormalizeOptions with string-only stripParams (RegExp forms stay code-side). */
	normalize?: Omit<NormalizeOptions, "stripParams"> & { stripParams?: string[] };
	/**
	 * Body persistence toggle, routed to the ./pg layer (doc 03's
	 * CrawlerPgOptions.persistBody) — NOT a CrawlOptions key. Predicate form is
	 * code-side only (the factory's `pg` options, item 6).
	 */
	persistBody?: boolean;
};

export interface CrawlJobPayload {
	seeds: string[];
	options?: SerializableCrawlOptions;
	/** Resume an existing crawl run (re-enqueue after crash/expiry). See item 7. */
	crawlUid?: string;
}

/** What the handler returns => steve stringifies into the job's result JSONB. */
export interface CrawlJobResult {
	crawlUid: string;
	/** "completed" | "maxPages" | ... | "abort" | "stop" — CrawlReport["stoppedBy"]. */
	stoppedBy: NonNullable<CrawlReport["stoppedBy"]>;
	/** Final counters only. byHost is dropped (unbounded cardinality on wide crawls). */
	stats: Omit<CrawlStats, "byHost">;
	/** steve attempt that produced this result; > 1 means a resume happened. */
	attempt: number;
	resumed: boolean;
}
```
- NEVER put `pages`, `graph`, bodies, or `onPage` data into `CrawlJobResult` (owner
  decision 3). Those live in `__crawler_page` / `__crawler_link` / `__crawler_url`.
- `collect` is excluded (and forced off by the handler, item 6): job mode streams
  pages/links into PG; an in-memory `report().pages` accumulation on a wide crawl would
  defeat decision 3 and the handler's retain-nothing rule.

- `deno.json`: add `"./steve": "./src/steve/mod.ts"` to the exports map (today the
  `exports` field is a single string — crawler/deno.json:4) and add
  `"@marianmeres/steve": "jsr:@marianmeres/steve@^3.0.0"` to imports (type-only usage;
  npm packaging treatment per the packaging doc — versionizeDeps gotcha noted there).

> **Fixed in verification:** the draft's Omit list named `persistBody`, which is not a
> doc-02 `CrawlOptions` key (it lives on doc 03's `CrawlerPgOptions`), and missed the
> nested non-serializables `robots.fetch` (FetchFn), RegExp `normalize.stripParams`, and
> the job-mode-hostile `collect` — all four corrected above.

**Files**
- `src/steve/mod.ts` (new; re-exports types + items 2/6)
- `src/steve/types.ts` (new)
- `deno.json` (exports map + steve import entry; coordinate with the packaging doc)

**Value/Effort/Risk** high / S / low — pure types + scaffold; only sync point is doc 02's
final `CrawlOptions` key list.

**Implementation notes**
- Add a type-level test (in item 9's test file) asserting no property of
  `SerializableCrawlOptions` is function-typed — a mapped-type
  `{ [K in keyof T]: T[K] extends (...a: never) => unknown ? K : never }[keyof T]`
  assigned to `never` catches doc-02 drift at compile time. The check is top-level
  only — nested groups (`scope`/`robots`/`normalize`) are covered by their explicit
  re-mappings above; extend the assertion to those sub-objects if doc 02 grows new
  nested members.
- Do not deep-validate payloads at the type level; runtime validation is item 6.

### 2. Enqueue + status helpers (`startCrawlJob`, polling pattern)

**What & why**
A one-call enqueue helper and the documented status story. "Is it in progress" is
answered by `jobs.find(uid)` — it works at any time, including mid-run, since it is a
plain SELECT by uid (steve/src/steve/jobs.ts:806-824, job/_find.ts:20-25). "How far
along, which URLs" is answered by the crawler's own tables through the `./pg` query API,
because steve has **no mid-run progress API** — verified against the entire public
surface: `src/mod.ts:27-29` exports only `jobs.ts`, `with-db-retry.ts` and
`db-health.ts`, and the `Jobs` class's public methods (`hasHandler`/`setHandler`/
`resetHandlers`/`start`/`stop`/`create`/`find`/`fetchAll`/`cleanup`/`healthPreview`/
`resetHard`/`uninstall`/`onDoneFor`/`onAttemptFor`/`onDone`/`onAttempt`/
`unsubscribeAll`/`getDbHealth`/`checkDbHealth`, jobs.ts:604-1155) include nothing that
writes progress; `result` is written exactly once, on success
(job/_handle-success.ts:26-35). Live progress therefore lives in
`__crawler_crawl.stats` (throttled updates) and `__crawler_page` rows (owner decision 4).

**Evidence / reuse**
- `find(uid)` mid-run: jobs.ts:806-824.
- Job statuses: `pending|running|completed|failed|expired` (jobs.ts:36-42).
- `create()` defaults: `max_attempts = 3`, `backoff_strategy = "exp"`,
  `max_attempt_duration_ms = 0` (jobs.ts:752-765).
- `JobCreateOptions` (tenant_id, run_at, ...): jobs.ts:208-223.
- In-process completion callback exists (`onDoneFor`, jobs.ts:1000-1005) but is pubsub in
  the worker process only — cross-process consumers must poll.

**Spec**
```ts
// src/steve/start.ts
export interface StartCrawlJobOptions extends JobCreateOptions {
	/** Job type to enqueue under. Default: CRAWL_JOB_TYPE. */
	type?: string;
	/** Attach this job to an existing crawl run (resume; see item 7). */
	crawlUid?: string;
}

export async function startCrawlJob(
	jobs: Jobs,
	seeds: string | string[],
	options?: SerializableCrawlOptions,
	jobOptions?: StartCrawlJobOptions,
): Promise<{ uid: string }>;
```
Behavior:
1. Normalize `seeds` to `string[]`; throw synchronously on empty/non-string input
   (validate BEFORE enqueue — a structurally invalid payload would otherwise burn all
   `max_attempts` for nothing).
2. Build `CrawlJobPayload { seeds, options, crawlUid }`; call
   `jobs.create(type ?? CRAWL_JOB_TYPE, payload, jobCreateOptions)` passing through
   `tenant_id`, `run_at`, `max_attempts`, `max_attempt_duration_ms`, `backoff_strategy`
   untouched (steve defaults stand: 3 attempts, exp backoff, no attempt timeout).
3. Return `{ uid: job.uid }`.

Consumer polling recipe (goes into README/JSDoc verbatim):
```ts
const { uid } = await startCrawlJob(jobs, "https://example.com", { maxPages: 500 });

// coarse: queue status ("is it in progress")
const { job } = await jobs.find(uid); // pending|running|completed|failed|expired

// fine: live crawl progress from the crawler's own tables (./pg query API, doc 03)
const run = await findCrawlByJobUid(db, uid, { tablePrefix }); // __crawler_crawl row
// run.status, run.stats => { done, failed, skipped, queued, bytes, ... }
// per-URL detail / errors: query __crawler_page by run.uid

// completion summary (small JSON, never bodies): job.result as CrawlJobResult
```
`findCrawlByJobUid` is `./pg` surface — the exact name is doc 03's to fix; the
**requirement is binding**: a lookup of the crawl-run row by `job_uid` (+ tenant) must
exist, since this is the only bridge from a steve uid to crawl progress.

**Files**
- `src/steve/start.ts` (new), re-exported from `src/steve/mod.ts`
- `README.md` (polling pattern in the Job mode section, item 8)

**Value/Effort/Risk** high / S / low — thin wrapper; risk only in doc-03 name sync.

**Implementation notes**
- Do not build a combined `getCrawlJobStatus(jobs, db, uid)` helper — it would couple
  the steve helper to `./pg` query options for no real win; recipes show composition.
- `%` complete is only meaningful with `maxPages`/bounded scope; document that `eta`
  semantics follow the core `CrawlStats` contract (doc 02).

### 3. Reaper & listing-window guidance (LOUD)

**What & why**
steve's opt-in `autoCleanup` reaper (JobsOptions, jobs.ts:296-297; loop at
jobs.ts:573-587) marks any job in `running` longer than `maxAllowedRunDurationMinutes`
as `expired` — **default 5 minutes** (AutoCleanupOptions, jobs.ts:246-251; manual
`cleanup()` has the same default, jobs.ts:904-905). Expired is TERMINAL — no auto-retry, by
design ("the work may now be stale", job/_mark-expired.ts:6-8; UPDATE at :30-38). A
normal crawl easily runs 5+ minutes, so default-configured autoCleanup will reap
perfectly healthy crawl jobs. Worse, the still-running handler keeps writing crawler
tables and, on real completion, flips the job back to `completed` unconditionally
(job/_handle-success.ts:26-35) — after `cleanup()` already published a spurious
`onDone` with an `expired` job (jobs.ts:918-934). This must be documented loudly.

**Evidence / reuse**
- jobs.ts:246-251 (defaults), :573-587 (reaper loop), :904-905 (cleanup default 5),
  :898-901 (autoCleanup reaps tenant-blind).
- _mark-expired.ts:6-8 (terminal, no auto-retry), :30-38 (the UPDATE).
- Listing window: `fetchAll` filters `created_at > NOW() - sinceMinutesAgo`,
  default 30 (job/_find.ts:50, :61-67; documented at jobs.ts:834).

**Spec**
Write the following guidance into: `createCrawlJobHandler` JSDoc, `startCrawlJob`
JSDoc, and a dedicated README call-out box in the Job mode section:
1. If the `Jobs` instance uses `autoCleanup`, it MUST be configured with
   `maxAllowedRunDurationMinutes` covering the WHOLE retry story, not one attempt: the
   reaper measures from the FIRST attempt's `started_at`, which is COALESCE-preserved
   across retries (_claim-next.ts:19; jobs.ts:168-169), so a resumed attempt inherits
   the elapsed time of every previous attempt plus backoff sleeps. Rule of thumb:
   `maxAllowedRunDurationMinutes >= max_attempts * ceil(maxDuration / 60_000) + 15`
   (15 min slack for backoff delays), or autoCleanup left off entirely with
   `jobs.cleanup(N)` called manually with a crawl-aware `N`.
2. A reaped crawl job is `expired` = terminal; steve will NOT retry it. Recovery is
   `startCrawlJob(jobs, seeds, options, { crawlUid })` with the crawl uid from
   `__crawler_crawl` (resume path, item 7).
3. `jobs.fetchAll(...)` only lists jobs created in the last 30 minutes by default —
   pass `{ sinceMinutesAgo }` explicitly when listing older crawl jobs. The real crawl
   history is `__crawler_crawl`, not steve rows.

**Files**
- `src/steve/handler.ts` + `src/steve/start.ts` (JSDoc), `README.md`

**Value/Effort/Risk** high / S / low — pure documentation, prevents the single most
likely production incident of job mode.

> **Fixed in verification:** the draft sized the reaper window to ONE crawl (+15 min);
> `started_at` survives retries (COALESCE, _claim-next.ts:19), so the window must cover
> all attempts plus backoff — formula corrected above, recipe (item 8) adjusted to match.

**Implementation notes**
- The factory (item 6) cannot see the consumer's `Jobs` config (it only produces a
  handler), so this cannot be enforced at runtime — which is exactly why the docs carry
  the weight. Do not add a runtime probe.

### 4. Type-blind claiming — deployment guidance

**What & why**
steve claims jobs with no type filter: the claim subquery selects by
`status = 'pending' AND run_at <= NOW()` only, `ORDER BY run_at, id FOR UPDATE SKIP
LOCKED` (steve/src/steve/job/_claim-next.ts:16-30, subquery :22-28). ANY started `Jobs`
instance on the same `tablePrefix` will claim `"crawl"` jobs. A worker that has no
handler for the type falls back to the global handler, and failing that to a **noop
handler that completes the job with `{ noop: true }`** (jobs.ts:510, fallback chain
:527-529) — the crawl silently never runs and the job reads `completed`.

**Evidence / reuse**
- _claim-next.ts:16-30; jobs.ts:510 (`noopHandler`), :527-529
  (`jobHandlers[job.type] ?? jobHandler ?? noopHandler`).
- `setHandler` for late registration: jobs.ts:625-632.

**Spec**
README + factory JSDoc deployment rules (pick one):
1. **Dedicated prefix (recommended):** give the crawl queue its own steve
   `tablePrefix` (e.g. `"crawlq"`) and start only crawl-capable workers on it.
2. **Shared prefix:** every worker process that calls `jobs.start()` on that prefix
   MUST register the crawl handler:
   `jobs.setHandler(CRAWL_JOB_TYPE, createCrawlJobHandler({...}))` — including workers
   that "only do email"; otherwise they will noop-complete crawl jobs they happen to
   claim.
Also note the corollary: two differently-configured crawl deployments (different
`baseOptions`) on one prefix must use distinct job types (`StartCrawlJobOptions.type` +
matching `jobHandlers` keys), or they will run each other's crawls with the wrong
code-side config.

**Files**
- `README.md` (Job mode > Deployment), `src/steve/handler.ts` (JSDoc)

**Value/Effort/Risk** high / S / low — documentation only; the failure mode it prevents
(silent noop-completion) is otherwise near-undebuggable.

**Implementation notes**
- Do not try to "fix" this in the crawler (e.g. payload signature checks) — claiming is
  steve's contract; guidance is the correct layer.

### 5. Cancellation: AbortSignal wiring

**What & why**
The steve handler contract is `(job, signal?) => result` (jobs.ts:78-81). The signal is
only present when the job was created with `max_attempt_duration_ms > 0` — `_executeJob`
wraps the handler in `withTimeout` only in that case, else calls `handler(job)` with no
signal (job/_execute.ts:30-38). On timeout `ac.abort()` and the `TimeoutError` rejection
fire in the same timer tick (`Promise.race`, utils/with-timeout.ts:21-29), and a
handler that ignores the signal keeps running in the background (jobs.ts:73-76,
with-timeout.ts:7-10). So once the signal fires the attempt is already lost — steve
records the `TimeoutError` failure regardless of anything the handler does after it —
and graceful draining is pointless zombie work that races the retry. The handler
must translate the signal into an immediate hard stop.

**Evidence / reuse**
- jobs.ts:73-81, job/_execute.ts:30-38, utils/with-timeout.ts:7-31.
- Crawler-side cancellation contract: `options.signal` and `abort()` propagate into
  every in-flight fetch (tmp/crawler-DESIGN.md:94-95, :329-331); page-fetcher propagates
  `signal` to platform fetch, browser navigation and retry sleeps
  (page-fetcher/src/types.ts:86-87).
- steve graceful stop waits for active jobs to finish (jobs.ts:560-567) and installs a
  SIGTERM handler by default (`gracefulSigterm`, jobs.ts:281-282, :484-493).

**Spec**
Inside the handler (item 6):
```ts
const handler: JobHandler = async (job, signal) => {
	signal?.throwIfAborted?.(); // already timed out before we started? bail now
	const crawler = createCrawler({ ...merged, signal }); // doc 02: signal = hard abort
	// ... run; page-fetcher cancels in-flight I/O via the same signal
};
```
Rules (also JSDoc'd):
1. Forward steve's signal as `CrawlOptions.signal` — the core treats a fired signal as
   `abort()` (hard: cancel in-flight, stop dispatching). No graceful `stop()` on this
   path: the attempt is already lost; per-page PG durability means at most the in-flight
   pages are dropped and re-claimed by the resume path (item 7).
2. Because steve passes NO signal when `max_attempt_duration_ms = 0` (the default), a
   job-mode crawl without its own budget can run forever. The factory logs one warning
   (via the optional `logger`, decision 7) when the merged options contain none of
   `maxDuration` / `maxPages` / `maxTotalBytes`.
3. Recommended pattern (README): bound crawls with `CrawlOptions.maxDuration` (graceful:
   run ends `stoppedBy: "maxDuration"`, the JOB COMPLETES with a summary) and use
   `max_attempt_duration_ms` only as a much larger safety net (abrupt: attempt fails,
   retry resumes). If both are set: `maxDuration < max_attempt_duration_ms`, and the
   reaper window (item 3) above both.
4. Shutdown interplay: `jobs.stop()` (and steve's default SIGTERM handling) waits for
   in-flight jobs — a multi-hour crawl blocks graceful shutdown for its remaining
   duration. Deployments needing fast shutdown either bound crawls with `maxDuration`,
   or hard-kill the process and recover via reaper + `crawlUid` resume. The library
   registers no signal handlers itself (design sketch :331).

**Files**
- `src/steve/handler.ts` (wiring), `README.md` (rules 3-4)

**Value/Effort/Risk** high / S / med — small code, but the semantics (abort-not-drain,
signal-only-with-timeout) are easy to get wrong; med risk is the dependency on doc 02
defining `CrawlOptions.signal` as hard-abort.

**Implementation notes**
- Do NOT `addEventListener("abort", () => crawler.stop())` — `stop()` drains in-flight
  pages, i.e. exactly the zombie behavior to avoid here.
- `signal.reason` should flow into the crawl row's `stopped_by` best-effort write
  (item 7 failure path) for diagnosability.

### 6. `createCrawlJobHandler` factory

**What & why**
The heart of the submodule: a factory producing a steve `JobHandler` that runs one crawl
per job on PG stores, keyed to the job, returning the small summary. All code-side
configuration (hooks, fetcher, RegExp scopes, `persistBody` predicate, custom anything)
enters here; the payload only overrides data options.

**Evidence / reuse**
- `JobHandler` contract: jobs.ts:78-81; result stringified: _handle-success.ts:15-23.
- Job fields available to the handler: `uid`, `payload`, `attempts`, `tenant_id`
  (jobs.ts:132-176; tenant at :148).
- Default fetcher mandate: page-fetcher `createFetcher()`
  (page-fetcher/src/fetcher.ts:155) with the HTTP adapter + crawler UA; `Fetcher`
  interface (fetcher.ts:112-125), `FetchFn` (types.ts:49); crawler disposes only what it
  created (owner decision 10).
- Per-URL live reporting comes from crawler tables as pages complete (owner decision 4)
  — the handler itself reports nothing per-URL to steve.
- Logger convention: `logger?: Logger` type-only from clog (clog/src/clog.ts:186),
  silent default (decision 7).

**Spec**
```ts
// src/steve/handler.ts
import type pg from "pg";
import type { CrawlerPgOptions } from "../pg/mod.ts"; // doc 03

export interface CreateCrawlJobHandlerOptions {
	/** Injected PG handle — job mode ALWAYS runs on PG stores (retry-resume needs them). */
	db: pg.Pool | pg.Client;
	/**
	 * Options for the ./pg persistence factory — doc 03's CrawlerPgOptions minus
	 * db/tenantId/logger (this factory supplies those): tablePrefix, persistBody
	 * (predicate-capable here, code-side), progressThrottleMs.
	 */
	pg?: Omit<CrawlerPgOptions, "db" | "tenantId" | "logger">;
	/** Convenience: fetcher instance or plain FetchFn; wins over baseOptions.fetcher. */
	fetcher?: Fetcher | FetchFn;
	/**
	 * Code-side option base: hooks, RegExp scope/normalize patterns, robots.fetch,
	 * events, priority fn, ... (the persistBody predicate goes on `pg`, not here —
	 * it is not a CrawlOptions key). Payload options override per TOP-LEVEL key
	 * (shallow merge; e.g. a payload `scope` replaces baseOptions.scope wholesale).
	 */
	baseOptions?: CrawlOptions;
	logger?: Logger;
}

export function createCrawlJobHandler(opts: CreateCrawlJobHandlerOptions): JobHandler;
```
Handler algorithm (per invocation, i.e. per attempt):
1. **Validate payload** as `CrawlJobPayload`: `seeds` non-empty `string[]`; unknown
   top-level option keys are warn-and-ignore (forward-compat), wrong-typed known keys
   throw (job fails/retries; `startCrawlJob` pre-validates so this only catches
   hand-rolled payloads).
2. **Merge options**: `merged = { ...baseOptions, ...payload.options }` — shallow, per
   top-level key, payload wins. Then force the non-negotiables: `stores` = the `./pg`
   stores bound to `opts.db`/`opts.pg.tablePrefix`; `logger` = `opts.logger`;
   `fetcher` = `opts.fetcher ?? baseOptions.fetcher ??` default page-fetcher stack
   (decision 10); `collect` = `{ pages: false, graph: false }` (retain nothing —
   pages/links stream into PG); payload `persistBody` (boolean) overrides
   `opts.pg.persistBody` in the ./pg factory; tenant = `job.tenant_id ?? "_default"`
   threaded into every `./pg` call (decision 6). Emit the missing-budget warning
   (item 5 rule 2).
3. **Resolve the crawl run**: `payload.crawlUid` if present, else look up
   `__crawler_crawl` by `job_uid = job.uid` when `job.attempts > 1` (retry). Found and
   resumable → resume path (item 7); none → create a new run row with
   `uid = crypto.randomUUID()`, `job_uid = job.uid`, seeds + options snapshot
   (serializable subset only), `status = 'running'`.
4. **Run**: drive the core crawler (doc 02 API) bound to the PG stores; forward the
   steve signal (item 5). The handler consumes `run()` for control flow only and
   retains NOTHING per-page in memory — pages/links/bodies are persisted by `./pg` as
   they complete; steve's `result` must stay small.
5. **Complete**: on natural end (completed or budget stop) return `CrawlJobResult`
   (item 1) built from the final stats; the crawl row terminal status is written by the
   core/persistence layer, `ended_at` set.
6. **Fatal error**: best-effort `UPDATE __crawler_crawl SET status='failed',
   stopped_by='error'` then **rethrow** — steve logs the attempt error and re-pends
   with backoff or fails at `max_attempts` (item 7).
7. **Dispose** (in `finally`): dispose the fetcher iff the handler created it
   (`Fetcher.dispose()` is idempotent and never throws, fetcher.ts:118-122); never
   dispose an injected fetcher or the injected `db`.

Retry layering (backbone rule, JSDoc'd on the factory): page-fetcher retries transport
errors per request; the crawler adds no per-page retry; steve retries the whole job —
safe only because of step 3's PG-keyed resume.

**Files**
- `src/steve/handler.ts` (new), re-export from `src/steve/mod.ts`

**Value/Effort/Risk** high / M / med — the merge/force rules and run-keying must match
doc 02 (options), doc 03 (store factories, crawl-row writes) exactly; that cross-doc
surface is the risk.

**Implementation notes**
- One handler instance must be safe for concurrent invocations (steve runs
  `processorsCount` workers, jobs.ts:664-701): no shared mutable state in the closure
  except the once-flags for warnings; stores/crawler instances are created per job.
- The options snapshot stored on the crawl row records the MERGED serializable subset
  (payload wins) — functions are unrepresentable there by construction.
- `payload.options.strategy: "priority"` without a code-side priority fn falls back to
  BFS with one warning (decision 13 keeps priority pluggable, default BFS).

### 7. Failure semantics + crash-resume on retry

**What & why**
Define exactly when a crawl job fails vs completes, and how a retry resumes instead of
restarting. steve's machinery: a thrown handler error logs the attempt and re-pends the
job with exp backoff (`2^attempts` s, capped 1 h) until `max_attempts`, then `failed`
(job/_handle-failure.ts:29-40, :55-67). A hard process crash leaves the row `running`;
only `cleanup()`/autoCleanup turns it `expired`, which is terminal — NOT retried
(_mark-expired.ts:6-8). So automatic retry covers thrown errors and attempt timeouts;
crash recovery after reaping is a manual re-enqueue with `payload.crawlUid`. Resume is
safe because all crawl state is in PG (backbone retry-layering rule).

**Evidence / reuse**
- _handle-failure.ts:29-40 (max attempts → failed), :55-67 (re-pend + backoff via
  `run_at`); _mark-expired.ts:6-8, :30-38 (expired = terminal).
- Claiming increments `attempts` before execution (_claim-next.ts:16-30), so
  `job.attempts === 1` identifies the first attempt inside the handler.
- Frontier per-run table with `status pending|in_flight|done` + FOR UPDATE SKIP LOCKED
  pop (backbone table set; SQL detail owned by doc 03).

**Spec**
Error taxonomy (JSDoc table on the factory):
| Condition | Handler behavior | Job outcome |
|---|---|---|
| Page-level fetch error (after page-fetcher retries), 4xx/5xx page | recorded in `__crawler_page`, counted in `stats.failed` — never thrown | job **completes** (with failure counts in the summary) |
| robots.txt 5xx | disallow-all for that origin + one warning (decision 14) | job completes |
| Circuit open / one host dead | pages skip/fail per core semantics | job completes |
| Invalid payload, store/DB errors, fetcher construction failure | mark crawl row `failed` best-effort, **throw** | attempt error → retry w/ backoff → `failed` at max_attempts |
| steve attempt timeout (signal fired) | crawler hard-aborts (item 5); `TimeoutError` recorded by steve | retry w/ backoff → resume |
| Process crash | nothing runs | row stuck `running` → reaper → `expired` (terminal); manual `crawlUid` re-enqueue |

Resume algorithm (handler step 3 expansion):
1. Target run = `payload.crawlUid` ?? lookup by `job_uid = job.uid` (only meaningful
   when `job.attempts > 1`). No run found → create fresh (attempt 1 died before the
   INSERT; nothing to resume).
2. Run status `completed` or `stopped` → return its stored summary idempotently
   (`resumed: true`, no crawl work). This absorbs the zombie edge where a timed-out
   background handler finished after steve recorded the timeout.
3. Run status `running` (crash/zombie) or `failed` (previous attempt threw) → resume:
   - `UPDATE __crawler_crawl SET status='running', job_uid=$currentJobUid`;
   - re-claim orphans: frontier rows `in_flight` → `pending` for this run (doc 03's
     draft bakes exactly this into `openCrawl(uid)`; the requirement is binding);
   - keep everything else: visited/done pages, links, url archive rows;
   - re-push seeds (frontier dedup makes this a no-op for known URLs);
   - recompute the stats baseline with COUNTs over `__crawler_page`/frontier at resume
     start, then continue incrementing (cheap, and correct after any crash point).
4. Zombie race (aborted-but-background handler vs the resumed attempt): the frontier
   pop's `FOR UPDATE SKIP LOCKED` serializes row claims, so double-processing is
   limited to in_flight rows re-claimed under a live zombie fetch; `__crawler_page`
   upsert is last-write-wins. Accepted and documented; the item-5 hard-abort wiring
   makes the window small.

**Files**
- `src/steve/handler.ts` (resume path), `README.md` (taxonomy table)

**Value/Effort/Risk** high / M / med — correctness hinges on doc 03 delivering the
job_uid lookup + in_flight re-claim primitives; the taxonomy itself is low-risk.

**Implementation notes**
- Do not auto-resume `expired` jobs from inside steve callbacks — expired is a terminal
  operator-visible state; recovery is an explicit re-enqueue (`startCrawlJob` with
  `crawlUid`), documented in item 3.
- Backoff means a resumed attempt may start minutes later; robots/politeness state is
  rebuilt fresh — only frontier/visited/pages are durable. Say so in JSDoc.

### 8. Job-mode recipe + recurring re-crawl reference

**What & why**
The design sketch ships a "job-library run" recipe (tmp/crawler-DESIGN.md:420) and
mandates that the binding lives in an adapter, never as a crawler import of the job
library (:401-407). This work item writes that recipe as the README's Job mode section:
worker process, enqueue, poll, query results — plus a reference-only recurring re-crawl
via @marianmeres/cron.

**Evidence / reuse**
- Sketch :401-407 (integration rule), :420 (recipe 6 — this replaces it; "checkpoint"
  and "SIGINT resume" wording is superseded by owner decision 9: resume is a property
  of the PG stores).
- cron `register(name, cronExpr, handler)`: cron/src/cron/cron.ts:969 — reference only,
  no dependency (the snippet lives in docs).
- `onDoneFor` (in-worker completion callback): jobs.ts:1000-1005.

**Spec**
README section "Job mode (steve)" containing, in order: the ONE CRAWL = ONE JOB rule,
the reaper call-out (item 3), the claiming rules (item 4), then:
```ts
// worker.ts — runs the crawls
import pg from "pg";
import { Jobs } from "@marianmeres/steve";
import { CRAWL_JOB_TYPE, createCrawlJobHandler } from "@marianmeres/crawler/steve";

const db = new pg.Pool({ connectionString: Deno.env.get("DATABASE_URL") });
const jobs = new Jobs({
	db,
	tablePrefix: "crawlq", // dedicated prefix — any worker on it claims these jobs
	jobHandlers: {
		[CRAWL_JOB_TYPE]: createCrawlJobHandler({
			db,
			pg: { tablePrefix: "crawlq" },
			baseOptions: {
				maxDuration: 30 * 60_000, // always budget job-mode crawls
				onPage: (res) => ({ title: res.title }), // code-side only — never in payload
			},
		}),
	},
	autoCleanup: { maxAllowedRunDurationMinutes: 120 }, // MUST cover ALL attempts + backoff (item 3)
});
await jobs.start(2);
```
```ts
// anywhere — enqueue and observe
import { startCrawlJob } from "@marianmeres/crawler/steve";

const { uid } = await startCrawlJob(jobs, "https://example.com", {
	maxPages: 500,
	scope: { subdomains: "same-host", exclude: ["/search"] }, // strings only in payload
});

// poll: coarse via steve, fine via crawler tables (see item 2 recipe)
// in-worker alternative: jobs.onDoneFor(uid, (job) => { ... }) — in-process pubsub only
```
```ts
// recurring re-crawl — reference only, no cron dependency in this package
cron.register("recrawl-docs", "0 3 * * *", async () => {
	await startCrawlJob(jobs, "https://example.com/docs", { maxPages: 1000 });
});
```
Close with the recovery snippet: reaped/expired job → `startCrawlJob(jobs, seeds,
options, { crawlUid })`.

**Files**
- `README.md`, `src/steve/mod.ts` (module-level JSDoc mirrors the worker snippet)

**Value/Effort/Risk** high / M / low — documentation, but it is the public face of job
mode; must stay byte-consistent with items 3-7.

**Implementation notes**
- The `onPage` line doubles as the scraping-escape-hatch demo (decision 5): recipes may
  show consumer-side parsing without the package depending on anything.
- Do not resurrect the sketch's "SIGINT resume + checkpoint" phrasing — resume is now
  "PG stores + crawlUid re-enqueue".

### 9. Integration tests (`./steve` against real PG + local HTTP fixture)

**What & why**
Prove the whole loop against a real steve instance and real PG: enqueue → claim →
crawl → summary; retry-resume; signal abort. Conventions per backbone decision 8:
`TEST_PG_*` env, shared `tests/_pg.ts createPg()`, `"_test_"` table prefix, `resetHard`
in setup, run with `deno test -A --env-file` (scaffold's bare `deno task test` lacks
`-A --env-file`; align the task or document the invocation — steve's own deno.json task
is the model: steve/deno.json `"test": "deno test -A --env-file"`).

**Evidence / reuse**
- steve's Jobs is fully driveable in-test (`start`/`create`/`find`/`onDoneFor`/`stop`,
  jobs.ts:664-728, :752-784, :806-824, :1000-1005); `resetHard()` at jobs.ts:976-978.
- Handlers are plain functions (jobs.ts:78-81) — the resume test can invoke the
  produced handler directly with hand-built `Job` objects, no queue needed.

**Spec**
`tests/steve.test.ts` (skip-all when `TEST_PG_*` env is absent, like the other PG
suites):
1. **E2E happy path**: `Deno.serve` fixture site (3-4 interlinked pages, ephemeral
   port); `Jobs` with `"_test_"` prefix + registered crawl handler; `startCrawlJob`;
   await completion via `onDoneFor` + poll fallback; assert `job.status ===
   "completed"`, `job.result` parses as `CrawlJobResult`, contains NO `pages`/`graph`/
   body-like keys, and `__crawler_page` has the expected rows.
2. **Payload override**: `options.maxPages = 1` in the payload beats a larger
   `baseOptions` value; `stoppedBy: "maxPages"` in the summary.
3. **Mid-run observability**: with a slow fixture (delayed responses), `jobs.find(uid)`
   reports `running` while `__crawler_crawl.stats` shows non-zero progress.
4. **Resume-on-retry (direct invocation)**: call the handler with a fake
   `Job { uid, attempts: 1, payload, tenant_id: null }` plus an `AbortController`
   signal; abort after the first page completes (fixture hit-counter); expect a throw /
   aborted end. Call again with `attempts: 2`, same `uid`, no signal: assert it resumes
   (crawl row reused, page 1 NOT re-fetched per the hit counter, run completes).
5. **Idempotent re-run**: invoke the handler a third time (`attempts: 3`) on the
   completed run: returns the stored summary with `resumed: true`, zero new fetches.
6. **Type-level**: the `SerializableCrawlOptions` no-function assertion from item 1.
Teardown: `jobs.stop()`, crawler-store `resetHard()`, server close — in `finally`.

**Files**
- `tests/steve.test.ts` (new), `tests/_pg.ts` + HTTP fixture helper (shared; created by
  doc 03's / core's test items — reuse, do not duplicate)

**Value/Effort/Risk** high / M / low — steve is easy to drive in tests; timing-sensitive
cases (3) need generous polling, not sleeps.

**Implementation notes**
- Keep `pollTimeoutMs` low (e.g. 50) on the test `Jobs` instance so suites stay fast.
- Direct-invocation tests (4/5) must build `Job` objects satisfying steve's `Job`
  interface (jobs.ts:132-176) — only `uid`, `attempts`, `payload`, `tenant_id` are read
  by the handler; type-assert the rest.

## Open questions / decisions needed

1. **`./pg` API names this doc leans on** (doc 03 to fix, then sync here): the
   crawl-run lookup by `job_uid` (doc 03's query API has `getCrawl(uid)`/`listCrawls`
   but nothing keyed by `job_uid` yet) and the stats-baseline recompute. The frontier
   "re-claim `in_flight` → `pending`" primitive is already covered — doc 03's draft
   bakes it into `openCrawl(uid)`. The requirements are specified above (items 2/7)
   and binding; only the names/signatures are open.
2. **Convenience resume helper**: ship `resumeCrawlJob(jobs, db, jobUid)` (looks up the
   crawl row and re-enqueues with `crawlUid`) in v1, or document the manual two-step
   only? Lean: document only; add the helper when a real consumer asks.
