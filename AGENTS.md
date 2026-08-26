# @marianmeres/crawler — Agent Guide

Website crawler: frontier, scope, politeness, link graph, budgets. Transport is
`@marianmeres/page-fetcher` — this package never opens a socket itself.

## Quick Reference

- **Stack**: TypeScript, Deno-first, ESM, published to JSR + npm. One runtime dependency
  (`@marianmeres/page-fetcher`); `pg` and `@marianmeres/steve` are **type-only** imports
  and optional npm peers.
- **Test**: `deno task test` (`deno test -A --env-file`). Hermetic — the default run
  opens no socket; the engine suites drive a fake fetcher over a fixture mini-site.
- **Build**: `deno task npm:build` → `.npm-dist/` (runs `tsc`, stricter than
  `deno check`).
- **Format/lint**: `deno fmt` / `deno lint`. Tabs, `lineWidth: 90`, `indentWidth: 4`.
- **Check**: `deno check src/**/*.ts tests/**/*.ts examples/*.ts`.

## Project Structure

```
src/mod.ts          — export "."         (createCrawler, crawl, types, ./url re-exports)
src/url/mod.ts      — export "./url"     (normalizeUrl, isSameSite, classifyLink)
src/extract/mod.ts  — export "./extract" (extractLinks, parseRobotsTxt, parseSitemap, …)
src/stores/mod.ts   — export "./stores"  (memory stores + the store interfaces)
src/pg/mod.ts       — export "./pg"      (createCrawlerPg: 5 tables, queries, archive)
src/steve/mod.ts    — export "./steve"   (createCrawlJobHandler, startCrawlJob)
src/{name}.ts       — flat re-export shims npmbuild needs; keep in sync with `exports`
src/types.ts        — the entire public type surface, types only
src/options.ts      — resolveCrawlOptions: defaults + validation (throws TypeError)
src/engine/         — internals: dispatcher, channel, scope, robots-gate, traps, stats,
                      private-host
tests/              — one file per concern; `_helpers.ts` (fake fetcher + mini-site),
                      `_pg.ts` (TEST_PG_* pool), `_fixtures.ts`
examples/           — 6 runnable recipes; import BY PACKAGE NAME, never from `src/`
docs/plan/          — the original spec (authoritative); docs/ship-v1/ — the v1 tracker
scripts/build-npm.ts — entry points, real dependency list, optional peers
```

## Critical Conventions

1. **Never add a retry.** page-fetcher retries a request; steve retries a whole crashed
   job. A failed fetch is a terminal `PageResult` carrying `error`, never a re-queue.
2. **`PageResult` never carries a body.** Bodies reach a consumer only through
   `ctx.fetchResult` during `onPage`/`onPageDone`. A 50k-page crawl must not accumulate.
3. **A skipped link is recorded, not dropped.** Every rejection sets
   `LinkRecord.skipReason` and increments `stats.skippedByReason`. A skip never becomes a
   placeholder `PageResult`.
4. **Hooks vs events.** Hooks (`beforeExtract`, `shouldVisit`, `onPage`, `onLink`)
   produce data and a throw fails the page. Events (`events.*`) observe; a throw is
   caught and logged, async handlers are not awaited.
5. **Injected resources are never disposed here.** A consumer's `Fetcher`, `pg.Pool` or
   steve `Jobs` is owned by the consumer. Only the engine-owned default fetcher is
   disposed.
6. **Memory-first, always.** `./pg` is opt-in; nothing in `src/` outside `src/pg/` and
   `src/steve/` may require a database.
7. **Mask credentials in every message.** URLs with userinfo stay **verbatim** in the
   fetch, the frontier key, `PageResult.url` and the PG rows — but every `logger?.*`
   call, warning and `Error` that interpolates a URL runs it through
   `maskUserinfo()` (`src/url/_mask-userinfo.ts`) first. The invariant is "every message
   site is masked", including sites whose URL provably cannot carry userinfo today.
8. **Explicit export lists, never `export *` from an internals file.** `_html.ts`,
   `_schema.ts` and `normalize-url.ts`'s `@internal` helper must not reach consumers.
9. **Examples are consumer code.** They import `@marianmeres/crawler[/sub]` through the
   self-import map in `deno.json`, and guard their runnable half behind
   `import.meta.main`.

## Store Interfaces (`./stores`)

Two seams, both async, both swappable (memory ↔ PG ↔ yours):

```ts
import type { FrontierItem, VisitedState } from "@marianmeres/crawler/stores";

interface FrontierStoreShape {
	/** `false` = rejected (duplicate or full) */
	push(item: FrontierItem): Promise<boolean>;
	/** claims atomically: pending → in_flight; ordered `(priority, seq)` */
	pop(
		filter?: { excludeHosts?: readonly string[]; now?: number },
	): Promise<FrontierItem | undefined>;
	/** terminal ack of a claimed item */
	ack(url: string): Promise<void>;
	/** claimed → pending again (abort with items in flight) */
	release(url: string, readyAt?: number): Promise<void>;
	/** pending only — in-flight items are not counted */
	size(): Promise<number>;
}

interface VisitedStoreShape {
	has(url: string): Promise<boolean>;
	add(url: string, state: VisitedState): Promise<void>;
	get(url: string): Promise<VisitedState | undefined>;
	count(): Promise<number>;
	/** optional — the 304 re-extraction path */
	getBody?(url: string): Promise<
		{ body: Uint8Array; contentType?: string; charset?: string } | null
	>;
}
```

`getBody?` is optional on purpose: it is only ever called where `VisitedState.hasBody` is
true, so the memory stores do not implement it. It exists because a `304` arrives
bodyless and an incremental re-crawl would otherwise traverse nothing.

## PG Schema (`./pg`)

Five tables, `${tablePrefix}__crawler_{url,crawl,page,link,frontier}`. Installed lazily
on first use — **there is no migration step and no DDL to hand-write**. The prefix may
carry a schema (`"myschema."`). Every row is scoped by `tenant_id` (default
`"_default"`).

| Table                | Holds                                                             |
| -------------------- | ----------------------------------------------------------------- |
| `__crawler_url`      | the URL archive: validators (`etag`, `last_modified`), body       |
| `__crawler_crawl`    | one row per run: `seeds`, `options`, `status`, `stats`, `job_uid` |
| `__crawler_page`     | one row per completed fetch of a run                              |
| `__crawler_link`     | the link graph edges of a run                                     |
| `__crawler_frontier` | the durable queue: `pending` / `in_flight`                        |

Invariants:

- **The body archive is `(tenant_id, url)`-keyed.** Two tenants crawling one site store
  the bytes twice. Tenant isolation is absolute; there is no cross-tenant read path.
- **`openCrawl()` is the resume path** and recovers the frontier first: whatever a
  crashed attempt left `in_flight` goes back to `pending`. Safe because one crawl runs in
  one process at a time.
- **`pruneUrls()` is the only data-destroying method.** It requires at least one filter
  and returns the deleted count.
- **The frontier `pop` keeps `host <> ALL($2::text[])`.** There is deliberately no
  host-status side table; do not add one without profiling first.

## Job Mode (`./steve`)

One crawl = one job, always PG-backed (retry has nowhere else to resume from). steve is
type-only: the consumer passes a live `Jobs` instance in.

Two failure modes are invisible at runtime and cannot be enforced from inside the handler
factory — both are documented in README.md and must stay documented:

1. steve's `autoCleanup` reaper defaults to `maxAllowedRunDurationMinutes: 5` and
   silently `expired`s a healthy crawl.
2. steve claims by `status`/`run_at` only, so a worker with no crawl handler on the same
   `tablePrefix` noop-completes the job.

There is **no `resumeCrawlJob()` helper** in v1. Recovery is the two-step
`getCrawlByJobUid(jobUid)` → `startCrawlJob(…, { crawlUid })`.

## Testing

- **PG suites skip silently.** Every DB-touching test is
  `Deno.test({ name, ignore: !Deno.env.get("TEST_PG_DATABASE") }, …)`. Without a database
  the suite still passes — it just runs _fewer_ tests. **A green run therefore does not
  prove the PG code was exercised.** Check the test count before believing a PG change.
- **Set up PG** by copying `.env.example` → `.env` and filling in `TEST_PG_*`
  (`TEST_PG_HOST`, `TEST_PG_DATABASE`, `TEST_PG_USER`, `TEST_PG_PASSWORD`,
  `TEST_PG_PORT`). `deno task test` loads it via `--env-file`.
- **Close every pool in a `finally`.** Deno's leak detection fails a test that leaves
  pool sockets open.
- **Never crawl the network in a test.** Use `siteFetch(SITE)` from `tests/_helpers.ts`.

## Before Making Changes

- [ ] Read `src/types.ts` — the public contract lives there, with the reasoning.
- [ ] Check `tests/options.test.ts` before changing any option: defaults and validation
      are pinned there.
- [ ] `deno task test`, `deno fmt`, `deno lint`.
- [ ] Changing `deno.json` `exports`? Update `src/{name}.ts` shims **and**
      `scripts/build-npm.ts` `entryPoints` — drift between the three is how this rots.
