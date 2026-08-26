# @marianmeres/crawler

WORK IN PROGRESS

## Job mode (`@marianmeres/crawler/steve`)

**One crawl is one job.** [`@marianmeres/steve`](https://jsr.io/@marianmeres/steve) gives the
crawl a durable queue entry, retry-with-backoff and a `find(uid)` status check — and nothing
else, because it has no mid-run progress API and writes a job's `result` exactly once, at the
end. Everything per-URL — live progress, pages, bodies, the link graph — lives in the
crawler's own PG tables and is read through `@marianmeres/crawler/pg`. Job mode is therefore
always PG-backed: a retried attempt has nowhere else to resume from.

steve is a type-only dependency: you pass a live `Jobs` instance in, the package never
constructs one.

### ⚠️ steve's reaper will expire a healthy crawl

steve's `autoCleanup` reaper is opt-in, but once enabled its `maxAllowedRunDurationMinutes`
defaults to **5**, and it marks any job that has been `running` longer than that as
`expired`. A crawl that runs longer than five minutes is the normal case, not a stuck worker
— so a default-configured reaper kills healthy crawls. Worse, it is silent: `expired` is
terminal (steve never retries it) while the handler keeps crawling in the background and, on
completion, flips the job row back to `completed`.

The window is measured from `started_at`, which steve preserves across retries (it is the
_first_ attempt's start), so it has to cover every attempt plus the backoff sleeps between
them:

```txt
maxAllowedRunDurationMinutes >= max_attempts * ceil(maxDuration / 60_000) + 15
```

The 15 minutes are slack for exponential backoff. The alternative is to leave `autoCleanup`
off and call `jobs.cleanup(N)` yourself with a crawl-aware `N`.

This assumes the crawl is budgeted, and it should be: bound it with `CrawlOptions.maxDuration`
(graceful — the run ends `stoppedBy: "maxDuration"` and the **job completes** with a summary)
and treat steve's `max_attempt_duration_ms` as a much larger safety net (abrupt — the attempt
fails and the retry resumes). Keep `maxDuration < max_attempt_duration_ms`, and the reaper
window above both.

### ⚠️ Claiming ignores the job type

steve claims by `status` and `run_at` only. **Any** `Jobs` instance started on the same
`tablePrefix` will claim a crawl job, and a worker with no handler for the type falls back to
steve's noop handler: it completes the job with `{ noop: true }`. The crawl never runs,
nothing throws, nothing is logged, and the job reads `completed`. Pick one:

1. **A dedicated `tablePrefix`** (recommended) — give the crawl queue its own prefix and start
   only crawl-capable workers on it.
2. **A shared prefix** — then _every_ worker process that calls `jobs.start()` on it must
   register the crawl handler, including the ones that "only send email":
   `jobs.setHandler(CRAWL_JOB_TYPE, createCrawlJobHandler({ db }))`.

And the corollary: two deployments with different code-side `baseOptions` on one prefix need
distinct job types (`startCrawlJob(…, { type })` plus a matching `jobHandlers` key), or each
will run the other's crawls with the wrong configuration.

### The worker

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
				maxDuration: 30 * 60_000, // always budget a job-mode crawl
				onPage: (res) => ({ title: res.title }), // code-side only — never in a payload
			},
		}),
	},
	autoCleanup: { maxAllowedRunDurationMinutes: 120 }, // MUST cover ALL attempts + backoff
});

await jobs.start(2);
```

Note that `jobs.stop()` — and steve's default SIGTERM handling — waits for in-flight jobs, so
a multi-hour crawl blocks a graceful shutdown for the rest of its duration. Deployments that
need to stop quickly either bound their crawls with `maxDuration` or hard-kill the process and
recover through the reaper plus a `crawlUid` re-enqueue (below). This package registers no
signal handlers of its own.

### Enqueue, and ask how it is going

```ts
// anywhere — enqueue
import { startCrawlJob } from "@marianmeres/crawler/steve";

const { uid } = await startCrawlJob(jobs, "https://example.com", {
	maxPages: 500,
	scope: { subdomains: "same-host", exclude: ["/search"] }, // strings only in a payload
});
```

Two questions, two different answers:

```ts
// coarse — the queue's view
const { job } = await jobs.find(uid); // pending | running | completed | failed | expired

// fine — the crawl's own view, live, at any point during the run
const crawl = await crawlerPg.getCrawlByJobUid(uid); // __crawler_crawl row
crawl?.stats; // { done, failed, skipped, queued, bytes, … }
// per-URL detail and page-level errors: the ./pg query API over __crawler_page

// once it is over: job.result is a CrawlJobResult — counters and a crawlUid,
// never pages and never bodies
```

In-worker, `jobs.onDoneFor(uid, (job) => { … })` is an alternative to polling — but it is
in-process pubsub, so a consumer in another process still polls.

`jobs.fetchAll()` lists only jobs created in the last 30 minutes unless you pass
`{ sinceMinutesAgo }`. steve rows are queue plumbing, not crawl history: the history that
keeps is `__crawler_crawl` (`crawlerPg.listCrawls()`).

### Recurring re-crawls

Reference only — this package depends on no scheduler:

```ts
// @marianmeres/cron
cron.register("recrawl-docs", "0 3 * * *", async () => {
	await startCrawlJob(jobs, "https://example.com/docs", { maxPages: 1000 });
});
```

### Recovering an expired (or otherwise dead) job

There is no `resumeCrawlJob()` helper. Recovery is a deliberate two-step, because `expired` is
an operator-visible state and re-enqueueing is an operator's decision:

```ts
const crawl = await crawlerPg.getCrawlByJobUid(expiredJobUid);
if (crawl) {
	// `options` is yours to pass again: the row's `crawl.options` records what ran, but as
	// JSONB rather than as a typed CrawlOptions
	await startCrawlJob(jobs, crawl.seeds, options, { crawlUid: crawl.uid });
}
```

`crawlUid` is what makes the new job a resume rather than a re-crawl: whatever the dead
attempt left in flight goes back into the queue, and the pages, links and archived bodies it
already wrote stay. Robots rules, politeness state and the in-memory budgets are rebuilt fresh
for each attempt, so a `maxPages: 100` crawl may fetch up to 100 pages _per attempt_.
