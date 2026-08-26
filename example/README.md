# The interactive example

A control panel for one crawl: paste seed URLs, set the budgets, pick which runner does
the work, and watch it happen — the counters from `CrawlStats`, the pages as they land,
and the link graph with the reason every skipped edge was skipped.

```bash
createdb example_crawler          # or set EXAMPLE_PG_* to a database you already have
deno task example                 # → http://127.0.0.1:8000
```

The bundle is committed, so that is all you need. If you change `example/src/main.ts`:

```bash
deno task example:build           # one-shot bundle → example/dist/bundle.js
deno task example:dev             # the same, in watch mode (run the server in another shell)
deno task example:theme mauveTeal # regenerate theme.css from another bundled palette
```

## Why a server

A browser cannot run a crawl. Cross-origin `fetch` is blocked by CORS, `robots.txt` would
be unreadable, and a crawl is a long-lived background job that outlives the page that
started it. So the browser holds the controls and [`server.ts`](./server.ts) does the
crawling, against PostgreSQL.

It needs a database because that is where a crawl's progress lives. `EXAMPLE_PG_*` in
`.env` points at it (see [`.env.example`](../.env.example)); the tables — the crawler's
five plus steve's queue — are installed on first use under the `example_` prefix, so
there is no migration step.

## Two runners, one view

The **Runner** switch picks who does the work:

|          | what runs the crawl                                                                                                 | what it costs                             |
| -------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `direct` | this process. `createCrawler()` streams pages, the `./pg` handle persists each one and publishes throttled progress | simplest; the crawl dies with the process |
| `queued` | one `@marianmeres/steve` job, run by an in-process worker                                                           | durable, retried, and it waits its turn   |

The polling half is **identical either way**, and that is the point of the demo.
Progress never comes from the runner — it comes from `__crawler_crawl.stats` and the
page/link tables, read back through `@marianmeres/crawler/pg`. steve has no mid-run
progress API and writes a job's `result` exactly once, at the end, so job mode would have
nothing live to show otherwise.

The one visible asymmetry is the handle. `direct` is polled by the crawl's own uid;
`queued` is polled by the **job** uid, because in job mode the crawl row does not exist
until a worker picks the job up — until then the only true answer is "pending, in the
queue". Both questions, and their two different answers, are what the status badges show.

## Stopping one

`direct` calls `crawler.stop()`. `queued` cannot — steve has no per-job cancel — so the
handler is built **per job** and each crawl gets an `AbortSignal` of its own on
`baseOptions`. That matters: steve's own signal means "this attempt timed out" and the
handler rethrows it so the job retries, whereas a crawl aborted through
`baseOptions.signal` ends `stopped`, which is what a person clicking Stop means.

## The budgets are the server's, not yours

`/api/crawl` crawls whatever URL it is handed, so every number the browser posts is
clamped server-side — `CAPS` in [`server.ts`](./server.ts):

|                            |                                                     |
| -------------------------- | --------------------------------------------------- |
| `maxPages`                 | ≤ 300                                               |
| `maxDepth`                 | ≤ 6                                                 |
| `maxDuration`              | ≤ 5 min                                             |
| `maxTotalBytes`            | 64 MB, always                                       |
| `concurrency`              | ≤ 8                                                 |
| `perHostDelay`             | ≥ 100 ms (a floor, not a cap)                       |
| seeds                      | ≤ 10                                                |
| concurrent `direct` crawls | 2 (queue mode has its own limit: one worker)        |
| robots.txt                 | always respected, unless `EXAMPLE_ALLOW_IMPOLITE=1` |

Whatever it takes away comes back in the response and is shown in the UI, because a demo
that quietly ignores what you typed teaches the wrong thing about the library's budgets.

> ⚠️ Even so: this fetches arbitrary URLs on request. It binds `127.0.0.1` unless you set
> `EXAMPLE_HOST`, and putting it somewhere public means accepting that anyone can point
> it at anyone.

## Routes

| Route                              | What it does                                                      |
| ---------------------------------- | ----------------------------------------------------------------- |
| `GET /`                            | the app (`index.html` + `dist/bundle.js` + the two stylesheets)   |
| `POST /api/crawl`                  | start one; answers with the handle to poll and what was clamped   |
| `GET /api/crawl/:mode/:uid`        | the poll — stats, then the pages and links since `?pages=&links=` |
| `POST /api/crawl/:mode/:uid/stop`  | ask a running crawl to wind down                                  |
| `GET /api/crawl/:mode/:uid/broken` | the broken-link report, once it has ended                         |
| `GET /api/crawls`                  | recent runs, so a reload can pick one back up                     |

The poll takes offset cursors rather than re-sending the whole table each second: both
lists are `ORDER BY id`, so they are append-only and an offset is a stable place to
resume from.

## How it is built

- [`@marianmeres/vanilla`](https://jsr.io/@marianmeres/vanilla) — `observable` state,
  markup in `<template>`s (`fromTemplate` / `refs`), one delegated listener tree.
- [`@marianmeres/design-tokens`](https://jsr.io/@marianmeres/design-tokens) — `theme.css`
  is generated (`deno task example:theme`) with the Bootstrap Reboot bridge that
  `reboot.css` consumes. Light/dark follows `:root.dark`.
- [`@marianmeres/deno-build`](https://jsr.io/@marianmeres/deno-build) — bundles
  `src/main.ts` into `dist/bundle.js`; no node_modules, no build config.

`src/version.generated.ts` is generated too (gitignored) — `deno task example:build`
writes it before bundling.

## Not the only examples here

[`recipes/`](./recipes) holds six runnable single-file recipes — broken links, sitemap
generation, scraping, incremental re-crawl, browser rendering, job mode — each one
consumer code you can read top to bottom.
