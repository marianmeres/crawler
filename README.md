# @marianmeres/crawler

[![NPM version](https://img.shields.io/npm/v/@marianmeres/crawler.svg)](https://www.npmjs.com/package/@marianmeres/crawler)
[![JSR version](https://jsr.io/badges/@marianmeres/crawler)](https://jsr.io/@marianmeres/crawler)
[![License](https://img.shields.io/npm/l/@marianmeres/crawler)](LICENSE)

Point it at a URL and iterate the pages of the site as they complete — with the link
graph, politely, and with budgets that actually stop it.

Transport is [`@marianmeres/page-fetcher`](https://jsr.io/@marianmeres/page-fetcher):
this package never opens a socket itself. That is also how browser-rendered crawling
works — build a page-fetcher browser adapter with your driver and pass the fetcher in.

- **Streaming and backpressured.** `run()` is an async iterator, so a slow consumer
  slows the crawl instead of filling memory.
- **Crawl the content, not the nav.** Follow only the links inside a page's main
  content, and get the content graph instead of the navigation graph.
- **Nothing is dropped silently.** Every link that is _not_ followed is still recorded,
  with a `skipReason`.
- **Layered persistence.** In-memory by default; opt into `./pg` for a resumable,
  queryable, incrementally re-crawlable run; opt into `./steve` to make a whole crawl one
  background job.
- **No runtime dependency you did not ask for.** `pg`, `@marianmeres/steve` and any
  browser driver are yours to install.

## Installation

```bash
deno add jsr:@marianmeres/crawler
```

```bash
npm install @marianmeres/crawler
```

The `./pg` and `./steve` subpaths need optional peers that npm does **not** auto-install:

```bash
npm install pg              # for @marianmeres/crawler/pg
npm install @marianmeres/steve   # additionally, for @marianmeres/crawler/steve
```

## Usage

```ts
import { createCrawler } from "@marianmeres/crawler";

const crawler = createCrawler({ maxPages: 500, perHostDelay: 250 });

for await (const page of crawler.run("https://example.com")) {
	console.log(page.status, page.url, `${page.links.length} links`);
}

console.log(crawler.report()?.stats);
```

Or, for a crawl small enough to hold in memory, the collect-everything convenience:

```ts
import { crawl } from "@marianmeres/crawler";

const report = await crawl("https://example.com", { maxPages: 50 });
console.log(report.stoppedBy, report.pages.length, report.graph.length);
```

`crawl()` differs from `createCrawler()` in exactly one way: `collect.pages` and
`collect.graph` default to `true`, so `report.pages` and `report.graph` are populated.

### What comes back

A `PageResult` per completed fetch — success **or** terminal failure. It carries the
normalized `url`, the `finalUrl` after redirects, `status`, `depth`, `title`,
`canonical`, `contentHash`, `timing`, and every extracted `links` record.

It deliberately does **not** carry the body: a 50k-page crawl would not fit in memory.
The bytes live on `ctx.fetchResult` for as long as the `onPage` hook runs — that is the
body access path, and the escape hatch for content processing:

```ts
import { createCrawler } from "@marianmeres/crawler";

const crawler = createCrawler({
	maxPages: 100,
	onPage: async (res, ctx) => {
		if (!res.ok) return undefined;
		const html = await ctx.fetchResult?.text();
		return { url: res.url, title: res.title, length: html?.length ?? 0 };
	},
});

for await (const page of crawler.run("https://example.com")) {
	if (page.data) console.log(page.data); // whatever onPage returned
}
```

## Crawl the content, not the nav

Every page of a site links to every other page through its navigation, so following
_every_ link gives you the navigation graph. Following only the links inside the page's
content gives you the content graph — which is usually what you came for. There are two
routes, and which one applies depends on the site's markup, not on your preference.

### The site has landmarks → `scope.followRegions`

```ts
import { createCrawler } from "@marianmeres/crawler";

const crawler = createCrawler({
	scope: { followRegions: ["main", "article"] },
});
```

Links outside the listed landmarks are still extracted and still recorded in the graph;
they are simply not visited, with `skipReason: "out-of-region"`.

Two things to know:

- **Prefer `["main", "article"]` over `["main"]`.** The reported region is the
  _innermost_ landmark, so a link inside `<main><article>` reports `"article"` and
  `["main"]` alone would skip the entire body of a typical blog or docs page.
- **A document with no landmark markup at all is not filtered.** Region filtering does
  not apply to a document that yielded no regioned links — without that fallback, one
  non-semantic page would silently dead-end the crawl. The engine warns once per crawl
  the first time it fires.

### The site has `<div class="main">` → `beforeExtract`

Most of the web has no landmarks. `beforeExtract` narrows the HTML that link discovery
runs over, which is where a content extractor goes:

```ts
import { createCrawler } from "@marianmeres/crawler";
// a sibling package, and NOT a dependency of this one — install it yourself
import { extractMainContent } from "@marianmeres/html-extract";

const crawler = createCrawler({
	beforeExtract: (html) => extractMainContent(html)?.html ?? html,
});
```

Three rules, because this hook is easy to get wrong:

1. **It narrows link discovery only.** `<head>`-derived data — title, meta-robots,
   `<link rel=canonical|next|prev|alternate>`, meta-refresh — is always read from the
   raw document, which a `<main>`-only narrowing would otherwise destroy.
2. **It never affects stored bytes.** `contentHash`, `PageResult.size`,
   `ctx.fetchResult` and the `./pg` body archive all keep the raw body.
3. **A throw is not fatal.** The engine falls back to the raw HTML and warns once per
   crawl — narrowing is an optimization, not a correctness requirement.

The two compose: narrowing runs first, then region filtering applies to whatever
landmarks remain (usually none, so the whole-document fallback makes it a no-op — the
intended outcome).

## Scope

`scope` decides which URLs the crawl is willing to follow. Every rejection is recorded
as a `skipReason` on the `LinkRecord`.

```ts
import { createCrawler } from "@marianmeres/crawler";

const crawler = createCrawler({
	scope: {
		subdomains: "same-host", // default; "same-site" | "any"
		exclude: [/\/search\b/, "/cart"],
		pathPrefix: "/docs",
		checkExternal: true, // fetch off-site links once, do not expand them
	},
});
```

### The `same-site` caveat

`subdomains: "same-site"` needs to know a host's registrable domain, and the built-in
resolver is a **small heuristic** — a handful of second-level labels (`co.uk`, `com.au`,
`gov.sk`, …) — not the full Public Suffix List. It gets the common cases right and can
be wrong on an exotic suffix.

The default `subdomains: "same-host"` does not use it at all and is unaffected. When
exactness matters at crawl level, scope explicitly with `include`/`exclude` instead. The
standalone `isSameSite`/`classifyLink` in the `./url` submodule accept a
`getRegistrableDomain` override backed by a real PSL; `CrawlOptions.scope` does not
expose that hook.

## Politeness and robots.txt

`perHostDelay`, `perHostConcurrency` and the global `concurrency` are the politeness
knobs; the effective per-host delay is `max(perHostDelay, robots Crawl-delay)`.

robots.txt is honored by default, cached per origin for the run, and fetched at most
once per origin no matter how many workers discover that host at the same time.

- **`robots: { respect: false }` is legal** — for your own or a staging site — and logs
  one warning at run start. An impolite crawler should be a deliberate act, not an
  accident.
- **A 4xx, or a robots.txt that could not be fetched, means allow-all.** A site with no
  robots.txt has no rules, and "I could not reach it" is indistinguishable from that.
- **A 5xx means disallow-all**, with one warning per origin. The polite reading of "I
  cannot tell you my rules right now" is to stay away.
- **A robots.txt served as HTML** (the SPA catch-all route) is read as "no rules" rather
  than parsed into accidental directives.

`robots: { sitemaps: true }` additionally seeds the frontier from the `Sitemap:` lines
of the seed origins' robots.txt before the first page is fetched. Those URLs are subject
to every check a link is.

## Budgets

A crawl without a budget is a crawl you cannot predict. All of these default to
unlimited:

| Option          | Effect                                                          |
| --------------- | --------------------------------------------------------------- |
| `maxPages`      | Stop after N completed fetches (successes **and** failures)     |
| `maxDuration`   | Stop N ms after `run()` starts; in-flight pages drain           |
| `maxTotalBytes` | Stop once cumulative response bytes cross N                     |
| `maxDepth`      | _Prunes_ expansion beyond a link distance — it does not stop    |
| `maxQueued`     | Frontier bound (default `100_000`); overflow skips `queue-full` |

`report.stoppedBy` says which one ended the run: `"completed"`, `"maxPages"`,
`"maxDuration"`, `"maxTotalBytes"`, `"stop"` or `"abort"`. `maxDepth` never appears
there — it prunes (visible as `skippedByReason["max-depth"]`) and the crawl then finishes
normally.

**`maxTotalBytes` is not page-fetcher's `maxBytes`.** page-fetcher's `maxBytes` caps a
_single_ response; `maxTotalBytes` is the crawl's cumulative total, checked after each
completion, so in-flight responses may overshoot it. Use both: one keeps a single
pathological URL from eating your memory, the other keeps the run bounded.

Traps — calendars, faceted search, path loops, soft-404 farms — are bounded separately
by `traps` (segment repeats, path depth, query-parameter count, URLs per path, duplicate
content-hash threshold), all with working defaults.

## Retries: who retries what

This is a layered rule, and getting it wrong means a crawl that retries the same page
three times at three different levels:

1. **page-fetcher retries a request.** Transport-level, per request, respecting
   `Retry-After`. It has already happened by the time this package sees anything —
   `PageResult.attempts` reports how many it took.
2. **The crawler never adds per-page retry.** A failed fetch is a terminal `PageResult`
   carrying `error`, not a re-queue. There is exactly one retry layer below it and it
   already ran.
3. **steve retries a whole crashed job.** In job mode only, and safe _only_ because the
   PG state resumes: a retried attempt picks up the frontier, the visited set and every
   page already fetched. A retry without PG would start from zero.

## Browser-rendered pages

Browser crawling is injection-only. Neither this package nor page-fetcher imports a
browser — Playwright and Puppeteer are yours to install, and never a dependency.

```ts
import { createCrawler } from "@marianmeres/crawler";
import { createFetcher } from "@marianmeres/page-fetcher";
import {
	createBrowserAdapter,
	createHttpAdapter,
	playwrightDriver,
} from "@marianmeres/page-fetcher/adapters";
import playwright from "playwright";

const NEEDS_JS = /^\/(app|dashboard|search)(\/|$)/;

await using fetcher = createFetcher({
	// the first adapter is the default route, the rest are reachable by name
	adapters: [
		createHttpAdapter(),
		createBrowserAdapter({
			driver: playwrightDriver(playwright),
			// a selector is the wait strategy that knows; "networkidle" is a soft wait
			wait: { selector: "[data-app-ready], main article", timeout: 15_000 },
		}),
	],
	// per request: robots.txt and static pages keep going through HTTP
	selectAdapter: (req) => NEEDS_JS.test(new URL(req.url).pathname) ? "browser" : "http",
});

// an injected fetcher is never disposed by the engine: you built it, you own it
const crawler = createCrawler({ fetcher, maxPages: 100, perHostDelay: 500 });
```

The browser adapter hands back the serialized, **post-JS** DOM. That one fact is what
makes the whole thing work: those are the bytes `extractLinks` sees (so JS-injected
links are discovered and followed), the bytes `contentHash` is computed over, and the
bytes `./pg`'s `persistBody` archives.

See [`example/recipes/spa-browser.ts`](./example/recipes/spa-browser.ts) for the runnable version.

## Persistence: PostgreSQL (`./pg`)

Memory is the default and stays the default — this package is never PG-only. `./pg` is
an opt-in that buys four things: a crawl that survives the process, a queryable archive,
incremental re-crawls, and live progress readable from another process.

Inject an open connection; the submodule installs its own five tables on first use, so
there is no migration step to run.

```ts
import pg from "pg";
import { createCrawler } from "@marianmeres/crawler";
import { createCrawlerPg } from "@marianmeres/crawler/pg";

// the pool is the caller's: this package never opens or closes one
const db = new pg.Pool({ connectionString: Deno.env.get("DATABASE_URL") });
const crawlerPg = createCrawlerPg({ db });

const run = await crawlerPg.createCrawl({ seeds: ["https://example.com"] });
const writes: Promise<void>[] = [];

const crawler = createCrawler({
	maxPages: 500,
	recrawl: true,
	// the durable frontier and visited set: a crash resumes where it stopped
	stores: run.stores,
	events: {
		onPageDone: (res, ctx) => void writes.push(run.persistPage(res, ctx)),
		onProgress: (stats) => void writes.push(run.progress(stats)),
	},
});

await run.markRunning();
for await (const page of crawler.run("https://example.com")) {
	console.log(page.notModified ? "304 unchanged" : page.status, page.url);
}
// the writes above start inside events, which the engine does not await
await Promise.all(writes);

const report = crawler.report()!;
await run.markEnded({
	status: report.stoppedBy === "completed" ? "completed" : "stopped",
	stoppedBy: report.stoppedBy,
	stats: report.stats,
});
```

Reporting is on the `CrawlerPg` handle: `listCrawls`, `listPages`, `listFailed`,
`listLinks`, `brokenLinks`, `listChanged`, `crawlStats`, `getBody`, `deleteCrawl`,
`pruneUrls`.

**Incremental re-crawl.** With `recrawl: true` the engine re-queues URLs the archive
already knows and re-fetches them conditionally. An unchanged page answers `304`:
nothing comes over the wire, its links are re-extracted from the archived bytes, and the
site is still traversed in full. `listChanged(uid, { against })` then diffs two runs by
content hash.

**`persistBody`.** The body archive is what makes the conditional re-fetch above
possible, and it is the table that grows. It is `true` by default and takes a predicate
form as the size knob — `persistBody: (res) => (res.contentType ?? "").includes("html")`
keeps the pages worth diffing and skips the PDFs. Turning it off is not free: a bodyless
URL is always re-fetched in full.

**`pruneUrls({ olderThan?, host? })`** is the only data-destroying method in the
package. It requires at least one filter, returns the deleted count, and pruning a body
makes the next re-crawl of that URL unconditional.

Everything is scoped to a `tenantId` (default `"_default"`) and prefixed by an optional
`tablePrefix`, which may carry a schema — `"myschema."` puts the whole set in
`myschema`.

## Security notes

### Private and internal hosts

`allowPrivateHosts` defaults to **`true`** — permissive, because crawling
`http://localhost:8000/` is the normal development case. Set it to `false` when the
crawl follows links written by other people:

```ts
import { createCrawler } from "@marianmeres/crawler";

const crawler = createCrawler({ allowPrivateHosts: false });
```

That turns on a best-effort SSRF guard covering loopback, the RFC 1918 ranges, CGNAT and
link-local (including the `169.254.169.254` cloud-metadata address). It is a
**string-only** check of the hostname: it cannot detect a public hostname that resolves —
or is rebound — to a private address. For real protection, resolve the hostname yourself
and re-check every returned address, or put the crawler behind an egress proxy.

### Credentials in URLs

A URL carrying userinfo — `https://user:pass@host/path` — is kept **verbatim**
everywhere it is load-bearing: it is what gets fetched, what keys the frontier and the
visited set, what a `PageResult.url` reports, and what the `./pg` rows store. Such URLs
are legitimately crawlable and stripping the credentials would simply break the crawl.

The counterpart is that a password never reaches a message: every log line, warning and
`Error` in this package masks it (`https://user:***@host/path`).

So: **prefer authenticating through fetcher headers**, which are never persisted —

```ts
import { createCrawler } from "@marianmeres/crawler";
import { createFetcher } from "@marianmeres/page-fetcher";

const fetcher = createFetcher({
	headers: { Authorization: `Bearer ${Deno.env.get("TOKEN")}` },
});
const crawler = createCrawler({ fetcher });
```

— and if you do pass `https://user:pass@host/`, expect it to be persisted as given.

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

## Submodules

| Import                         | Contains                                                                               |
| ------------------------------ | -------------------------------------------------------------------------------------- |
| `@marianmeres/crawler`         | `createCrawler`, `crawl`, the `./url` functions, and the whole public type surface     |
| `@marianmeres/crawler/url`     | `normalizeUrl`, `isSameSite`, `classifyLink`, `getRegistrableDomain` — dependency-free |
| `@marianmeres/crawler/extract` | `extractLinks`, `extractTitle`, `parseRobotsTxt`, `parseMetaRobots`, `parseSitemap`    |
| `@marianmeres/crawler/stores`  | `createMemoryFrontier`, `createMemoryVisited`, and the store interfaces to implement   |
| `@marianmeres/crawler/pg`      | `createCrawlerPg` — the five-table PostgreSQL persistence and query API                |
| `@marianmeres/crawler/steve`   | `createCrawlJobHandler`, `startCrawlJob`, `CRAWL_JOB_TYPE` — one crawl as one job      |

`./url` and `./extract` import nothing and never throw; both are useful entirely on their
own if all you have is one HTML string.

Full API documentation, generated from the source:
[jsr.io/@marianmeres/crawler/doc](https://jsr.io/@marianmeres/crawler/doc).

## Examples

### The interactive one

```bash
createdb example_crawler   # then fill EXAMPLE_PG_* in .env — see .env.example
deno task example          # → http://127.0.0.1:8000
```

A control panel for one crawl: paste seed URLs, set the budgets, pick whether the crawl
runs in-process or as a `./steve` job, and watch it happen — live counters, the pages as
they land, and the link graph with the reason every skipped edge was skipped. Both
runners are polled the same way, out of the crawler's own tables, which is exactly how
you would watch a crawl from another process. See [`example/`](./example).

### The recipes

Runnable single-file recipes in [`example/recipes/`](./example/recipes), each
`deno run -A --env-file example/recipes/<name>.ts <url>`:

| Example                                                                    | Shows                                       |
| -------------------------------------------------------------------------- | ------------------------------------------- |
| [`broken-links.ts`](./example/recipes/broken-links.ts)                     | dead targets + the pages linking to them    |
| [`sitemap-gen.ts`](./example/recipes/sitemap-gen.ts)                       | a `sitemap.xml` from a crawl                |
| [`scraper.ts`](./example/recipes/scraper.ts)                               | `onPage` as the crawler/scraper boundary    |
| [`incremental-recrawl-pg.ts`](./example/recipes/incremental-recrawl-pg.ts) | crawl, re-crawl, diff — on PostgreSQL       |
| [`spa-browser.ts`](./example/recipes/spa-browser.ts)                       | HTTP + browser adapters, routed per request |
| [`steve-job.ts`](./example/recipes/steve-job.ts)                           | enqueue, run a worker, watch it live        |

## License

[MIT](LICENSE)
