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

## Clicking a page

Every row in the Pages tab opens a modal on that page, in three tabs:

| Tab             | What it is                                                                                                                                     |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **Preview**     | the archived DOM in a sandboxed iframe (`sandbox=""` — no scripts, no same-origin), with a `<base>` injected so its own CSS and images resolve |
| **HTML source** | those same bytes, raw                                                                                                                          |
| **Extracted**   | `@marianmeres/html-extract` over them: metadata, JSON-LD, embedded JSON, microdata, and the main content as markdown                           |

The Extracted tab shows the same document twice on purpose. **At crawl time** is what
`onPage` returned — a small summary the `./pg` layer stored in `__crawler_page.data` as
JSONB, queryable without touching the archive. That is the crawler's scraper boundary,
and it is what production wiring looks like. **Now, from the archive** is `extract()`
re-run on the stored body when you opened the modal, so the full document costs nothing
per row and changing what is extracted is a reload rather than a re-crawl.

The modal needs an archived body, which is what **Archive rendered HTML** controls (on by
default, and html-only — a PDF in the URL archive helps nobody).

## Rendering the JavaScript

**`@marianmeres/html-extract` does not execute JavaScript.** It is linkedom-based and
says so itself: _"No network, no JavaScript execution, no persistence — pure functions
over a string."_ It is the **document** layer, a sibling of the crawler, and it is only
ever as rendered as the string it was handed.

The rendering is the **transport** layer's job, one package down. Tick **Render with JS**
and every document goes through `createBrowserAdapter` on a Playwright driver instead of
plain HTTP:

```
Playwright → browser adapter → post-JS DOM → persistBody archives those bytes
                                           → html-extract reads them back
```

The adapter returns `page.content()` **after** the wait strategy resolved, i.e. the
serialized post-JS DOM. That one fact is what makes the chain work: those are the bytes
`extractLinks` sees (so JS-injected links are discovered and followed), the bytes
`contentHash` covers, and the bytes `persistBody` archives — so the Preview is the
rendered page and the Extracted tab reads the rendered document.

Two consequences worth knowing:

- **Playwright is yours, never this package's.** Neither the crawler nor page-fetcher
  imports a browser. Without it the toggle disables itself and says so. To enable it:
  `deno add npm:playwright && deno run -A npm:playwright install chromium`.
- **Budgets tighten.** A rendered page costs roughly a second and a browser context, so
  with JS on the ceilings drop to 60 pages and 2 at a time. One browser serves the whole
  process, with pooled contexts, and is disposed at shutdown.

robots.txt never goes through the browser — the engine gives robots its own plain HTTP
fetcher — and neither do URLs that are plainly not documents (`.css`, `.json`, images…).

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
| with **Render with JS** on | 60 pages, 2 at a time                               |

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
| `GET /api/page?url=…`              | one page's archived HTML + its extracted document                 |
| `GET /api/capabilities`            | what this server can do — browser available? which caps?          |
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
- [`@marianmeres/html-extract`](https://jsr.io/@marianmeres/html-extract) — the document
  layer, on the server: the crawl-time `onPage` summary and the modal's Extracted tab.
- Playwright — optional, yours, and the only thing here that runs JavaScript.

`src/version.generated.ts` is generated too (gitignored) — `deno task example:build`
writes it before bundling.

## Not the only examples here

[`recipes/`](./recipes) holds six runnable single-file recipes — broken links, sitemap
generation, scraping, incremental re-crawl, browser rendering, job mode — each one
consumer code you can read top to bottom.
