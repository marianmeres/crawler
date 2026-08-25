<!--
GENERATED PLAN — @marianmeres/crawler, remaining v1 work (was docs/plan backlog ranks 19-27)
Produced 2026-08-25 by re-cutting docs/plan/PROGRESS.md's open backlog into the current
MULTISTEP_PROGRESS_FILESYSTEM_LAYOUT_INSTRUCTIONS.md + sprint/SPEC.md tracker format.
Claims re-verified against the working tree at commit cebf5d0. No code was changed.
-->

# `./pg` — schema, stores, persistence, query API

> Nothing of `./pg` exists yet: `src/pg/` is not a directory, `pg` is not in the import
> map, and the `exports` map deliberately ships only the submodules that are written
> (task 5's decision). This sprint creates the whole submodule, in the dependency order
> the source doc gives — harness, schema, factory, stores, writers, readers — so that
> every task after the first can be tested the moment it lands.
>
> The authoritative spec, including the full DDL, every SQL statement and the reasoning
> behind the latest-per-URL body model, is
> [`../plan/03-pg-persistence.md`](../plan/03-pg-persistence.md). Read the numbered
> section named in each task below; this doc records only the current state of the tree,
> the **Done when** criterion, the affected files, and the decisions taken since.
>
> **This sprint needs a live PostgreSQL.** Every task's Done when is written to fail
> loudly if the PG suite is silently skipped — that is the one failure mode that would
> let nine tasks land green without a single statement ever reaching a database.

## Summary

| # | Task | Value | Effort | Risk |
|---|------|-------|--------|------|
| T21 | PG test harness (`tests/_pg.ts`, env, gating) | high | S | low |
| T19 | Schema DDL — the 5 tables | high | M | med |
| T20 | `createCrawlerPg` factory + lifecycle | high | M | low |
| T22 | `PgFrontierStore` / `PgVisitedStore` | high | M | med |
| T23 | `persistPage` writers | high | M | med |
| T24 | Live progress writer | high | S | low |
| T25 | Consumer query / reporting API | high | M | low |
| T26 | Incremental re-crawl (validators, 304 path) | high | M | med |
| T27 | PG integration tests | high | M | low |

## Tasks

### T21 — PG test harness (`tests/_pg.ts`, env, gating)

**Why first** — the source doc's build order starts at the schema, but the schema's own
Done when is a test, and there is no way to run one without this. It has no code
dependencies at all.

**What to build** — [`../plan/03-pg-persistence.md`](../plan/03-pg-persistence.md) §2.
`tests/_pg.ts` is steve's file verbatim, reproduced here so this task needs nothing
outside the repo:

```ts
import pg from "pg";

const { PG_HOST, PG_DATABASE, PG_USER, PG_PASSWORD, PG_PORT } = {
	PG_HOST: Deno.env.get("TEST_PG_HOST") || "localhost",
	PG_DATABASE: Deno.env.get("TEST_PG_DATABASE"),
	PG_USER: Deno.env.get("TEST_PG_USER"),
	PG_PASSWORD: Deno.env.get("TEST_PG_PASSWORD"),
	PG_PORT: Deno.env.get("TEST_PG_PORT") || "5432",
};

export function createPg() {
	return new pg.Pool({
		host: PG_HOST,
		user: PG_USER,
		database: PG_DATABASE,
		password: PG_PASSWORD,
		port: parseInt(PG_PORT),
	});
}
```

Plus: `"pg": "npm:pg@^8.21.0"` and `"@types/pg": "npm:@types/pg@^8.20.0"` in
`deno.json` imports (task 5's rule — a dependency enters when the first line of code
imports it, and that line is this one); the `.env.example` block from the source doc;
and the gating helper every PG suite uses:

```ts
const hasPg = !!Deno.env.get("TEST_PG_DATABASE");
Deno.test({ name: "pg: …", ignore: !hasPg }, async () => { /* … */ });
```

Gating is a **silent** `ignore` (2026-08-25 decision), documented in AGENTS.md by T37.
`deno task test` is already `deno test -A --env-file`, so no task change is needed.

**Done when** — `tests/_pg.ts` exists, `deno task test` still passes with `TEST_PG_*`
unset (no new failures, no noise), and a throwaway `Deno.test` that opens `createPg()`,
runs `SELECT 1` and closes the pool in `finally` passes with `TEST_PG_*` set. Deno's
leak detection must stay green — every suite closes its pool.

**Affected files** — `tests/_pg.ts`, `.env.example`, `deno.json` (imports only).

### T19 — Schema DDL, the 5 tables

**What to build** — [`../plan/03-pg-persistence.md`](../plan/03-pg-persistence.md) §3,
which carries the complete DDL for `__crawler_url|crawl|page|link|frontier` and the
index set. `src/pg/_schema.ts` exports `_schemaCreate`, `_schemaDrop`, `_initialize`,
`_uninstall` in cron 3.x's shape, with cron's `safe()` index-name strip so a
`"myschema."` prefix works.

Two constraints are not negotiable and are the reason this task carries `med` risk:
there is **no migration ledger** (the blob re-runs on every fresh process and must
converge from any starting state — hence `IF NOT EXISTS` everywhere and self-healing
`ALTER … ADD COLUMN IF NOT EXISTS` for later growth), and **CHECK constraints go only on
structurally stable unions** (`status`, `kind`, `discovered_via`) because
`CREATE TABLE IF NOT EXISTS` never updates an existing table's CHECK — `rel` and
`skip_reason` get none.

`tenant_id TEXT NOT NULL DEFAULT '_default'` and the per-tenant body copy are settled
owner decisions; see the Decisions log. Bodies stay `(tenant_id, url)`-keyed.

**Done when** — `tests/pg-schema.test.ts` passes against a live PG: the create blob runs
twice with no error and no duplicate objects, `_uninstall` → `_initialize` round-trips,
a `"_test_"` prefix and a `"myschema."`-style prefix both produce valid object names, and
every table listed above exists with its indexes. The test file must fail — not skip —
when `TEST_PG_DATABASE` is set but the connection is refused.

**Affected files** — `src/pg/_schema.ts`, `tests/pg-schema.test.ts`.

### T20 — `createCrawlerPg` factory + init/lifecycle plumbing

**What to build** — [`../plan/03-pg-persistence.md`](../plan/03-pg-persistence.md) §4:
`CrawlerPg` owning the injected `db`, the table prefix, the tenant, lazy
`#initOnce()`-guarded schema init awaited at the top of every public DB method,
`createCrawl`/`openCrawl` returning a bound `CrawlPersistence`, `resetHard()`,
`uninstall()`, `static __schema()`, and the `createCrawlerPg()` alias. `pg` is imported
**type-only**; the consumer injects the Pool/Client.

`src/pg/utils/with-transaction.ts` is steve's 60-liner, vendored (steve and cron each
carry their own copy — sharing it is not the ecosystem precedent). Reproduced verbatim so
this task needs nothing outside the repo:

```ts
import type pg from "pg";

// deno-lint-ignore no-explicit-any -- pg's .query overloads are complex and vary by driver
export type Queryable = { query: (...args: any[]) => Promise<any> };

/** `pg.Pool` exposes `totalCount`/`idleCount`/`waitingCount`; `pg.Client` does not. */
export function isPool(db: pg.Pool | pg.Client): db is pg.Pool {
	return (
		typeof (db as unknown as { connect?: unknown }).connect === "function" &&
		"totalCount" in db
	);
}

export async function withTransaction<T>(
	db: pg.Pool | pg.Client,
	fn: (client: pg.PoolClient | pg.Client) => Promise<T>,
): Promise<T> {
	const pool = isPool(db);
	const client = pool ? await (db as pg.Pool).connect() : (db as pg.Client);
	try {
		await client.query("BEGIN");
		try {
			const result = await fn(client);
			await client.query("COMMIT");
			return result;
		} catch (e) {
			try {
				await client.query("ROLLBACK");
			} catch {
				// ROLLBACK itself may fail on an already-aborted connection; best-effort.
			}
			throw e;
		}
	} finally {
		if (pool) (client as pg.PoolClient).release();
	}
}
```

`markRunning()` uses the COALESCE-first-start idiom (`started_at = COALESCE(started_at,
NOW())`) so a resumed attempt keeps its original start time. When `db` is a `pg.Client`
rather than a Pool, serialize transactions behind an internal promise chain and document
that a Pool is strongly recommended for `concurrency > 1`.

**Done when** — `tests/pg-lifecycle.test.ts` passes: `createCrawl` inserts a `pending`
row with the given seeds/options snapshot and returns a handle whose `crawl.uid` matches;
`markRunning()` then `markEnded({status: "completed"})` walks the CHECKed status column
without violating it and preserves `started_at` across a second `markRunning()`;
`openCrawl(uid)` returns the same row; `resetHard()` twice does not throw; and the same
suite passes with a `pg.Client` in place of the Pool.

**Affected files** — `src/pg/mod.ts`, `src/pg/crawler-pg.ts`,
`src/pg/utils/with-transaction.ts`, `deno.json` (`"./pg"` exports + self-import entries),
`tests/pg-lifecycle.test.ts`.

**Notes** — the `exports` map grows one entry per submodule as it lands (task 5's
decision); add `"./pg"` here, not earlier. `src/pg/mod.ts` re-exports an explicit list,
and `tests/mod.test.ts` pins every module's export list — extend it.

### T22 — `PgFrontierStore` / `PgVisitedStore`

**What to build** — [`../plan/03-pg-persistence.md`](../plan/03-pg-persistence.md) §5:
the two doc-02 store interfaces over the frontier and url tables, bound to one crawl row.
The doc carries every statement, including the `FOR UPDATE SKIP LOCKED` pop, the
`ON CONFLICT (crawl_id, url) DO NOTHING` push whose conflict target *is* the dedup, and
the `openCrawl` in-flight recovery (`in_flight` → `pending`).

Three details the interface makes easy to get wrong: `push()` returns `true` **iff** a
row was inserted (`false` is the duplicate signal the engine reads); `pop` must pass an
empty array rather than NULL for `excludeHosts` (hence the
`cardinality($2::text[]) = 0` guard); and `add()` writes **both** the `__crawler_url`
validator row and a `status = 'done'` frontier row, because doc 02's redirect
intermediates are marked visited without ever being enqueued and `has()` would otherwise
re-enqueue them.

**Decided 2026-08-25** — pop keeps `host <> ALL($2::text[])`; the host-status side table
stays unbuilt until profiling asks for it. The exclusion list is bounded by the crawl's
*active* host count, not by the site's, and the index makes the residual filter cheap.

**Done when** — `tests/pg-frontier.test.ts` passes: push dedup (second push of a URL
returns `false`, one row); pop ordering by `(priority, id)`; `excludeHosts` honoured with
an empty and a non-empty list; `ready_at` in the future is not popped; **two concurrent
pops on two clients never return the same row**; `ack`/`release` move status as
specified; `openCrawl` resets `in_flight` rows to `pending`; visited `has`/`add`/`get`/
`count` round-trip a `VisitedState` including `hasBody`, with tenant isolation checked by
a second `CrawlerPg` on a different `tenantId`.

**Affected files** — `src/pg/stores.ts`, `src/pg/crawler-pg.ts`,
`tests/pg-frontier.test.ts`.

### T23 — `persistPage` writers (archive, page, links, ack)

**What to build** — [`../plan/03-pg-persistence.md`](../plan/03-pg-persistence.md) §6:
one `withTransaction` per completed page doing the url-archive upsert (with the
body-keep/replace CASE), the page upsert, the delete-then-`UNNEST`-insert link replace,
and the frontier ack. Atomic and idempotent by construction — that is what makes steve's
retry-the-whole-job model safe, so replaying `persistPage` on the same result must
produce identical rows.

`data` is the `onPage` return value: pre-check it with a guarded `JSON.stringify`; on
throw store `NULL`, log one `logger?.warn` naming the URL, and never fail the page write.
Log lines here go through T39's `maskUserinfo`.

**Done when** — `tests/pg-persist.test.ts` passes the body matrix the source doc calls
non-optional: changed hash replaces the body; identical hash keeps the stored bytes and
touches `fetched_at`; a 304 (everything NULL but status) keeps the body; a non-ok
response keeps the previous good body while updating `last_status`; `persistBody: false`
and a `persistBody` predicate both leave `body` NULL; two identical `persistPage` calls
leave exactly one page row and one set of link rows; a `BigInt` in `onPage` data lands as
`NULL` with one warning and a still-successful write.

**Affected files** — `src/pg/persist.ts`, `src/pg/crawler-pg.ts`,
`tests/pg-persist.test.ts`.

### T24 — Live progress writer (`__crawler_crawl.stats`)

**What to build** — [`../plan/03-pg-persistence.md`](../plan/03-pg-persistence.md) §1:
`progress(stats)` on the crawl handle, throttled to at most one write per
`progressThrottleMs` (default 1000) with a trailing flush, so a caller can wire it 1:1 to
`onProgress` without thinking. Failures log and swallow — a progress write must never
fail a crawl. `markEnded()` force-writes the final snapshot past the throttle.

Throttle state is **per crawl handle**, not per `CrawlerPg` instance: two concurrent
crawls on one instance must not starve each other.

**Done when** — `tests/pg-progress.test.ts` passes: N rapid `progress()` calls inside one
window produce one intermediate UPDATE and one trailing UPDATE carrying the **last**
snapshot; `markEnded` writes the terminal stats even when called inside a throttle
window; a forced query error inside `progress()` is logged and does not reject; two
handles from one `CrawlerPg` both write within one window.

**Affected files** — `src/pg/crawler-pg.ts`, `tests/pg-progress.test.ts`.

### T25 — Consumer query / reporting API

**What to build** — [`../plan/03-pg-persistence.md`](../plan/03-pg-persistence.md) §7:
`getCrawl`, `listCrawls`, `crawlStats`, `listPages`, `listFailed`, `listLinks`,
`brokenLinks`, `getBody`, `listChanged`, `deleteCrawl`, plus the two the job-mode sprint
binds to and which are therefore **not optional**: `getCrawlByJobUid(jobUid)` and
`recomputeStats(uid)`. Row types are camelCase mappings exported from `./pg`. Pagination
defaults `limit 100`, hard cap 1000, `ORDER BY id`.

**Decided 2026-08-25** — `pruneUrls({ olderThan?, host? })` ships in v1 (owner call). It
is the only data-destroying method in the package: require at least one filter, return
the deleted count, and carry a JSDoc warning that pruned bodies make the next re-crawl of
those URLs unconditional (T26's `hasBody` rule).

**Done when** — `tests/pg-query.test.ts` passes against a persisted fixture crawl: every
method returns the expected rows and respects its filters; `brokenLinks` groups dead
targets with their `from` pages; `listChanged` reports new/changed/removed against an
explicit `against` run and against the auto-selected previous completed run;
`deleteCrawl` cascades pages/links/frontier and leaves `__crawler_url` intact;
`getCrawlByJobUid` finds a run by its `job_uid`; `recomputeStats` reproduces the counters
of a hand-built set of page rows; `pruneUrls` refuses a filterless call and deletes
exactly what its filter names.

**Affected files** — `src/pg/query.ts`, `src/pg/crawler-pg.ts`, `src/pg/mod.ts`,
`tests/pg-query.test.ts`.

### T26 — Incremental re-crawl (validators, the 304 path)

**Where it stands** — the engine half is **already built**: `#conditionalHeaders()`
(`src/engine/dispatcher.ts:717-731`) seeds `If-None-Match`/`If-Modified-Since` from
`visited.get()` but only when `state.hasBody === true`, and the memory store forces
`hasBody: false` for exactly this reason (task 11). What does not exist is any store that
can answer `true`, and what happens after a 304: today a bodyless response extracts no
links (`dispatcher.ts:644`), so an incremental re-crawl would traverse nothing.

**What to build** — [`../plan/03-pg-persistence.md`](../plan/03-pg-persistence.md) §8:
`getValidators(url)` and `getStoredBody(url)` on the crawl handle, `PgVisitedStore.get()`
returning a truthful `hasBody`, and the 304 write path (`status 304`, `ok`,
`not_modified`, `content_hash` copied from the url row, `fetched_at`-only touch).

Then the piece the source doc leaves to "doc 02/04 wiring" and nobody owns yet: **on a
304 the engine re-extracts links from the stored body**. Copying the previous run's edges
was weighed and rejected — those `followed`/`skip_reason` flags were computed under
possibly different options. Reaching the body store-agnostically needs one interface
addition:

```ts
// src/stores/types.ts — VisitedStore
/** The stored body, when this store keeps one. Only ever called where `hasBody`. */
getBody?(url: string): Promise<
	{ body: Uint8Array; contentType?: string; charset?: string } | null
>;
```

Optional, so the memory store is unaffected and no existing implementation breaks; the
engine calls it only on a 304, which the `hasBody` gate already guarantees can only
happen where a body exists. This is the one public-contract change in this sprint —
`tests/mod.test.ts`'s export pin and the `VisitedStore` JSDoc both need updating.

**Done when** — `tests/pg-incremental.test.ts` passes: a second crawl of an unchanged
fixture sends both validators and records `notModified` pages whose **links are still
extracted and followed** (the fixture's link graph is fully traversed on the 304 run);
a URL with validators but no stored body (`persistBody: false`) is fetched
unconditionally; a changed body produces a new `content_hash` and a `listChanged`
"changed" row; the stored body is decoded with its stored charset.

**Affected files** — `src/pg/persist.ts` (or `query.ts`), `src/pg/stores.ts`,
`src/stores/types.ts`, `src/engine/dispatcher.ts`, `tests/pg-incremental.test.ts`.

### T27 — PG integration tests

**What to build** — [`../plan/05-testing-docs-release.md`](../plan/05-testing-docs-release.md)
§4: the end-to-end pass that the per-task suites above do not cover — a **whole crawl** of
`SMALL_SITE` through `siteFetch` into PG stores plus persistence, on the `"_test_"`
prefix, asserting the crawl row's lifecycle `pending → running → completed` with live
stats JSONB updated on the way, one page row per fetched URL with correct depth and
`discovered_via`, link rows covering the graph including skipped edges, and the url
archive holding latest-per-URL bodies. Reuse `SMALL_SITE`/`siteFetch` from
`tests/_helpers.ts` — PG tests stay network-free; only the database is real.

**Done when** — `tests/pg-integration.test.ts` passes with `TEST_PG_*` set, and
`deno task test` **with `TEST_PG_*` set** reports the full suite green with a PG test
count greater than zero (record the number in the task's commit message so a later
silent-skip regression is visible).

**Affected files** — `tests/pg-integration.test.ts`, `tests/_helpers.ts` (only if a
fixture needs widening).
