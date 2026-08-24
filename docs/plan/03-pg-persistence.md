<!--
GENERATED ANALYSIS — @marianmeres/crawler implementation plan
Produced 2026-08-24 by multi-agent research -> adversarial verify -> synthesize.
Claims verified against ecosystem package working trees (page-fetcher v0.4.0, steve v3.0.0,
cron v3.2.0, clog v3.21.0). The crawler repo itself is a pre-first-commit scaffold.
Planning artifact; no code was changed.
-->

# PostgreSQL Layer (`./pg`) — Schema, Stores, Query API

> The `./pg` submodule turns the crawler from a run-and-forget tool into a system of
> record: crawl state, results, the link graph and **raw bodies** live in five tables, so a
> crashed run resumes, a re-crawl turns into mostly 304s, and per-URL reporting is a SQL
> query away. Memory stores remain the default; PG is strictly opt-in and injected
> (`db: pg.Pool | pg.Client`, `import type pg` only), following the steve/cron conventions
> to the letter.
>
> The single most important design fact: the body archive is **URL-keyed, latest-only**
> (`__crawler_url`), while everything per-run (`__crawler_crawl/page/link/frontier`) only
> references it. That split is what makes incremental re-crawl cheap (validators live on
> the URL row) and keeps run history small (bodies are never duplicated per run).
>
> Headline recommendation: implement persistence as **one idempotent transaction per
> completed page** (url upsert + page upsert + link replace + frontier ack). Idempotent
> per-page transactions are also what makes the steve retry-the-whole-job model safe. Skip
> `@marianmeres/batch` buffering in v1 — politeness bounds page throughput far below
> anything PG notices, and cross-page buffering would enlarge the crash-redo window.

## Summary of work items

| # | Work item                                             | Value | Effort | Risk |
|---|-------------------------------------------------------|-------|--------|------|
| 1 | Live progress writer (`__crawler_crawl.stats`)        | high  | S      | low  |
| 2 | PG test harness (`tests/_pg.ts`, env, tasks)          | high  | S      | low  |
| 3 | Schema DDL — the 5 tables                             | high  | M      | med  |
| 4 | `createCrawlerPg` factory + init/lifecycle plumbing   | high  | M      | low  |
| 5 | `PgFrontierStore` / `PgVisitedStore`                  | high  | M      | med  |
| 6 | Result persistence — `persistPage` writers            | high  | M      | med  |
| 7 | Consumer query / reporting API                        | high  | M      | low  |
| 8 | Incremental re-crawl mechanics (validators, 304 path) | high  | M      | med  |

Build order (dependencies, not table order): 3 → 4 → 2 → 5 → 6 → 1 → 7 → 8.

## Work items (detailed)

### 1. Live progress writer (`__crawler_crawl.stats`)

**What & why** — steve has no mid-run progress API (verified against its full public
surface; a running job is observable only via `find(uid)` on the queue row). The owner
decision therefore places live progress in the crawler's own crawl-run row: a throttled
`UPDATE ... SET stats = $1` that job-mode consumers (doc 04) and dashboards poll. Without
it, a 3-hour crawl is a black box until it ends.

**Evidence / reuse**
- steve autoCleanup reaps `running` jobs after 5 minutes by default
  (steve/src/steve/jobs.ts:246-251) and steve exposes no heartbeat/progress hook — the
  crawl row is the only live signal.
- `CrawlStats` shape comes from the design sketch (tmp/crawler-DESIGN.md:389-398); the
  engine already emits it via the throttled `onProgress` event
  (tmp/crawler-DESIGN.md:384).

**Spec**
```ts
// On the bound CrawlPersistence handle (see item 4):
progress(stats: CrawlStats): Promise<void>;
```
- SQL: `UPDATE ${t.crawl} SET stats = $2, updated_at = NOW() WHERE id = $1`.
- Throttled internally: at most one write per `progressThrottleMs` (factory option,
  default `1000`). Calls inside the window resolve immediately after storing the pending
  snapshot; a trailing write flushes the last snapshot when the window elapses. Callers
  may therefore wire it 1:1 to `onProgress` / `onPageDone` without thinking.
- `markEnded()` (item 4) always force-writes the final stats — the terminal snapshot is
  never lost to throttling.
- Failures: log via `logger?.warn` and swallow — a progress write must never fail the
  crawl (same spirit as the engine's safeEmit rule).

**Files** — `src/pg/crawler-pg.ts` (method), covered by `tests/pg-persist-query.test.ts`.

**Value/Effort/Risk** — high / S / low. Pure convenience SQL, but it is the owner's
stated observability mechanism for job mode.

**Implementation notes** — keep the throttle state per crawl handle (one timer + one
pending snapshot), not per instance; two concurrent crawls on one `CrawlerPg` must not
starve each other.

### 2. PG test harness (`tests/_pg.ts`, env, tasks)

**What & why** — every other item in this doc is untestable without a live-PG harness.
Copy the steve/cron pattern verbatim: `TEST_PG_*` env, a tiny `createPg()` pool factory,
`"_test_"` table prefix, `resetHard()` before each test.

**Evidence / reuse**
- steve/tests/_pg.ts:1-19 — `createPg()` reading `TEST_PG_HOST/DATABASE/USER/PASSWORD/PORT`
  with `localhost`/`5432` defaults.
- steve/.env.example — the `TEST_PG_*` block this package's `.env.example` should mirror.
- cron/tests/cron-db.test.ts:25 — `const TABLE_PREFIX = "_test_";`.
- steve/tests/jobs.test.ts:17,41 — per-suite prefix constant + `await jobs.resetHard();`
  as the per-test clean-slate.
- steve/deno.json:6 — test task is `deno test -A --env-file`.

**Spec**
- `tests/_pg.ts`: byte-for-byte the steve version (it is already minimal).
- `.env.example` (currently a placeholder comment — replace):
```
# FOR POSTGRES (USED IN TESTS ONLY)
TEST_PG_HOST=localhost
TEST_PG_DATABASE=crawler_test
TEST_PG_USER=
TEST_PG_PASSWORD=
TEST_PG_PORT=5432
```
- `deno.json` tasks: `"test": "deno test -A --env-file"` (currently plain `deno test`),
  same for `test:watch`.
- Every PG test creates its `CrawlerPg` with `tablePrefix: "_test_"` and calls
  `resetHard()` first.
- One deliberate deviation from steve/cron (where a missing DB hard-fails the suite):
  guard each PG `Deno.test` with `ignore: !Deno.env.get("TEST_PG_DATABASE")` so the
  package's many pure/unit suites (url, extract, memory stores) still pass on machines
  without PG. Document the env requirement in the README dev section.

**Files** — `tests/_pg.ts`, `.env.example`, `deno.json` (tasks; coordinate with doc 05
item 1, which owns the scaffold/exports changes), `tests/pg-*.test.ts` consumers.

**Value/Effort/Risk** — high / S / low.

**Implementation notes** — close the pool in `finally` (`await pool.end()`) per test or
use a shared runner like steve's `tests/_tests-runner.ts`; Deno leaks-detection will fail
tests that leave pool sockets open.

### 3. Schema DDL — the 5 tables

**What & why** — column-level truth for the whole PG layer. Style template is cron 3.x
(the newest/strictest schema in the ecosystem): `uid UUID NOT NULL DEFAULT
gen_random_uuid()`, `tenant_id ... NOT NULL DEFAULT '_default'`, CHECK-constrained
statuses, `TIMESTAMPTZ`, `IF NOT EXISTS` everywhere, index names via a `safe()` strip so
`"myschema."` prefixes work.

**Evidence / reuse**
- cron/src/cron/_schema.ts:33-62 — the style template: uid/tenant defaults, CHECKed
  status columns, `safe()` (line 18), unique `(tenant_id, name)` index.
- steve/src/steve/job/_schema.ts:55-60 — the convergence rule this schema must obey:
  there is **no migration ledger**; the blob is re-run on every fresh process and must
  converge any starting state (self-heal `ALTER ... ADD COLUMN IF NOT EXISTS` precedent).
- steve/src/steve/jobs.ts:313-318 — `${tablePrefix}__job` double-underscore base-name
  convention.
- Enum sources: `discovered_via` union tmp/crawler-DESIGN.md:151; `LinkRecord.kind/rel`
  tmp/crawler-DESIGN.md:164-174; `SkipReason` tmp/crawler-DESIGN.md:286-287.

**Spec** — `src/pg/_schema.ts` exports `_schemaCreate(ctx)`, `_schemaDrop(ctx)`,
`_initialize(ctx, hard)`, `_uninstall(ctx)` exactly like cron/_schema.ts:4-112. Table
names: `${p}__crawler_url|crawl|page|link|frontier`. DDL (abridged only where marked):

```sql
CREATE TABLE IF NOT EXISTS ${p}__crawler_url (
    id            SERIAL PRIMARY KEY,
    tenant_id     TEXT NOT NULL DEFAULT '_default',
    url           TEXT NOT NULL,          -- normalized (./url output)
    body          BYTEA,                  -- raw bytes; NULL = never persisted
    content_type  TEXT,
    charset       TEXT,
    etag          TEXT,                   -- verbatim response header
    last_modified TEXT,                   -- verbatim; replayed as If-Modified-Since
    content_hash  TEXT,                   -- opaque change token (engine-computed)
    last_status   INTEGER,
    size          INTEGER,
    fetched_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_${safe(url)}_tenant_url
    ON ${p}__crawler_url(tenant_id, url);

CREATE TABLE IF NOT EXISTS ${p}__crawler_crawl (
    id         SERIAL PRIMARY KEY,
    uid        UUID NOT NULL DEFAULT gen_random_uuid(),
    tenant_id  TEXT NOT NULL DEFAULT '_default',
    seeds      JSONB NOT NULL DEFAULT '[]',
    options    JSONB NOT NULL DEFAULT '{}',  -- JSON-safe snapshot, fns/stores stripped
    status     VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','running','completed','failed','stopped')),
    stats      JSONB NOT NULL DEFAULT '{}',  -- live CrawlStats (item 1)
    stopped_by VARCHAR(20),                  -- CrawlReport.stoppedBy value
    error      TEXT,
    job_uid    UUID,                         -- steve linkage (doc 04); no FK — steve
                                             -- reaps its rows, ours must survive
    started_at TIMESTAMPTZ,
    ended_at   TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_${safe(crawl)}_uid ON ${p}__crawler_crawl(uid);
CREATE INDEX IF NOT EXISTS idx_${safe(crawl)}_tenant_created
    ON ${p}__crawler_crawl(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_${safe(crawl)}_job_uid
    ON ${p}__crawler_crawl(job_uid) WHERE job_uid IS NOT NULL;  -- doc 04 lookup

CREATE TABLE IF NOT EXISTS ${p}__crawler_page (
    id             SERIAL PRIMARY KEY,
    tenant_id      TEXT NOT NULL DEFAULT '_default',
    crawl_id       INTEGER NOT NULL,
    url_id         INTEGER,                -- archive ref; NULL when no response observed
    url            TEXT NOT NULL,          -- normalized, as enqueued
    final_url      TEXT,
    depth          INTEGER NOT NULL DEFAULT 0,
    discovered_via VARCHAR(20) NOT NULL DEFAULT 'link'
        CHECK (discovered_via IN ('seed','link','sitemap','redirect','canonical','manual')),
    referrer       TEXT,
    status         INTEGER,                -- NULL on transport error / skip
    ok             BOOLEAN NOT NULL DEFAULT FALSE,
    not_modified   BOOLEAN NOT NULL DEFAULT FALSE,
    content_type   TEXT,
    content_hash   TEXT,                   -- per-run copy => listChanged diffs runs
    title          TEXT,
    size           INTEGER,
    attempts       INTEGER NOT NULL DEFAULT 0,
    timing         JSONB NOT NULL DEFAULT '{}',   -- { total, fetch, extract }
    error_kind     VARCHAR(40),
    error_message  TEXT,
    skip_reason    VARCHAR(30),            -- non-NULL => popped but never fetched
    data           JSONB,                  -- onPage return (JSON-serializable only)
    fetched_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    FOREIGN KEY (crawl_id) REFERENCES ${p}__crawler_crawl(id)
        ON UPDATE CASCADE ON DELETE CASCADE,
    FOREIGN KEY (url_id) REFERENCES ${p}__crawler_url(id)
        ON UPDATE CASCADE ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_${safe(page)}_crawl_url
    ON ${p}__crawler_page(crawl_id, url);

CREATE TABLE IF NOT EXISTS ${p}__crawler_link (
    id          SERIAL PRIMARY KEY,
    tenant_id   TEXT NOT NULL DEFAULT '_default',
    crawl_id    INTEGER NOT NULL,
    from_url    TEXT NOT NULL,             -- normalized source page
    to_url      TEXT NOT NULL,             -- normalized absolute target
    raw_href    TEXT,
    kind        VARCHAR(10) NOT NULL DEFAULT 'internal'
        CHECK (kind IN ('internal','external')),
    rel         VARCHAR(20) NOT NULL DEFAULT 'page',   -- no CHECK, see note
    nofollow    BOOLEAN NOT NULL DEFAULT FALSE,
    anchor_text TEXT,
    followed    BOOLEAN NOT NULL DEFAULT FALSE,
    skip_reason VARCHAR(30),                           -- SkipReason; no CHECK, see note
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (crawl_id) REFERENCES ${p}__crawler_crawl(id)
        ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_${safe(link)}_crawl_to ON ${p}__crawler_link(crawl_id, to_url);
CREATE INDEX IF NOT EXISTS idx_${safe(link)}_crawl_from ON ${p}__crawler_link(crawl_id, from_url);

CREATE TABLE IF NOT EXISTS ${p}__crawler_frontier (
    id             SERIAL PRIMARY KEY,
    tenant_id      TEXT NOT NULL DEFAULT '_default',
    crawl_id       INTEGER NOT NULL,
    url            TEXT NOT NULL,
    host           TEXT NOT NULL,
    depth          INTEGER NOT NULL DEFAULT 0,
    priority       DOUBLE PRECISION NOT NULL DEFAULT 0,  -- BFS default: priority = depth
    discovered_via VARCHAR(20) NOT NULL DEFAULT 'link'
        CHECK (discovered_via IN ('seed','link','sitemap','redirect','canonical','manual')),
    referrer       TEXT,
    meta           JSONB,
    status         VARCHAR(10) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','in_flight','done')),
    ready_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    claimed_at     TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (crawl_id) REFERENCES ${p}__crawler_crawl(id)
        ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_${safe(frontier)}_crawl_url
    ON ${p}__crawler_frontier(crawl_id, url);
CREATE INDEX IF NOT EXISTS idx_${safe(frontier)}_pop
    ON ${p}__crawler_frontier(crawl_id, status, priority);
```

Behavioral column semantics this DDL encodes:
- **Latest-per-URL bodies**: `__crawler_url` holds exactly one row per `(tenant_id, url)`.
  The body is replaced only when `content_hash` changes; an unchanged 304 fetch touches
  `fetched_at` (and `last_status`) only. Exact upsert SQL in item 6.
- **tenant_id TEXT** (not cron's `VARCHAR(255)`) is the owner-specified type; the
  NOT-NULL-'_default' shape is cron's.
- **`job_uid` has no FK on purpose** — steve's `fetchAll` window defaults to 30 minutes
  (steve/src/steve/job/_find.ts:50) and its rows get cleaned up; crawl rows must outlive
  the queue row they came from.
- **CHECK policy**: CHECKs only on unions that are structurally stable (`status`, `kind`,
  `discovered_via`). `rel` and `skip_reason` get none: `CREATE TABLE IF NOT EXISTS` never
  updates an existing table's CHECK, so any union growth would strand deployed tables
  (the ledger-less blob must converge — steve/_schema.ts:55-60). If a CHECKed union ever
  changes, the fix is an appended self-heal `ALTER` line in the blob, steve-style.
- Drop order in `_schemaDrop`: frontier, link, page, crawl, url (children first), matching
  cron/_schema.ts:4-10 style.

**Files** — `src/pg/_schema.ts`; `tests/pg-schema.test.ts` (create idempotency: run the
blob twice; `"myschema."` prefix smoke test; resetHard/uninstall round-trip).

**Value/Effort/Risk** — high / M / med. Risk: schema decisions are the hardest to walk
back once anything real runs against them; the no-ledger convergence rule must be treated
as a constraint on every future edit.

**Implementation notes** — `gen_random_uuid()` is core in PG 13+ (cron already relies on
it; no extension needed). URL columns are capped operationally by the crawler's
`maxUrlLength` (default 2048, tmp/crawler-DESIGN.md:279) which keeps the unique btree
entries well under the index-size limit — no DB-side length CHECK needed.

### 4. `createCrawlerPg` factory + init/lifecycle plumbing

**What & why** — the `./pg` public entry. One object owning the injected connection, the
table names, tenant scoping, lazy schema init, and handing out per-crawl bound handles
(stores + writers). Conventions are steve/cron's, copied exactly, so a consumer who knows
one `@marianmeres` PG package knows this one.

**Evidence / reuse**
- steve/src/steve/jobs.ts:268-298 — options shape precedent (`db: pg.Pool | pg.Client`,
  `tablePrefix?`, `logger?`).
- steve/src/steve/jobs.ts:476-482 — `#initializeOnce()` once-guard; called from every
  public DB method (e.g. jobs.ts:766, 811, 860).
- steve/src/steve/jobs.ts:976-977 — `resetHard()` delegates to init with `hard = true`;
  jobs.ts:1185-1194 — `static __schema(tablePrefix)` returning `{ drop, create }`.
- steve/src/steve/utils/with-transaction.ts:23-28 — `isPool` via the `totalCount`
  duck-type; :38-63 — `withTransaction` acquiring one client per tx (cron's
  with-tx.ts:10-13 is the same duck-type).
- Logger contract: silent-by-default `logger?: Logger`, re-exported type-only, as
  page-fetcher does (page-fetcher/src/types.ts:287-292).
- `pg`/`@types/pg` import-map entries: steve/deno.json:26-27; npm build precedent:
  steve/scripts/build-npm.ts lists them in `versionizeDeps`.

**Spec**
```ts
// src/pg/crawler-pg.ts
import type pg from "pg";
import type { Logger } from "@marianmeres/clog";      // re-exported from ./pg mod

export const DEFAULT_TENANT_ID = "_default";

export interface CrawlerPgOptions {
    db: pg.Pool | pg.Client;
    tablePrefix?: string;                 // default ""; "myschema." capable
    tenantId?: string;                    // default DEFAULT_TENANT_ID
    logger?: Logger;                      // default undefined = silent
    persistBody?: boolean | ((res: PageResult) => boolean);  // default true
    progressThrottleMs?: number;          // default 1000
}

export class CrawlerPg {
    constructor(options: CrawlerPgOptions);

    // run lifecycle — both return a bound handle
    createCrawl(input: {
        uid?: string;                     // default crypto.randomUUID()
        seeds: string[];
        options?: Record<string, unknown>;  // JSON-safe snapshot
        jobUid?: string;
    }): Promise<CrawlPersistence>;
    openCrawl(uid: string): Promise<CrawlPersistence>;  // resume: recovers in_flight

    // query/reporting API — item 7
    // getCrawl, listCrawls, crawlStats, listPages, listFailed, listLinks,
    // brokenLinks, getBody, listChanged, deleteCrawl

    resetHard(): Promise<void>;           // drop + recreate (tests)
    uninstall(): Promise<void>;           // drop only
    static __schema(tablePrefix?: string): { drop: string; create: string };
}

/** Convenience alias so the package reads factory-style like its siblings. */
export function createCrawlerPg(options: CrawlerPgOptions): CrawlerPg;

export interface CrawlPersistence {
    readonly crawl: CrawlRow;
    readonly stores: { frontier: FrontierStore; visited: VisitedStore };  // doc-02 ifaces
    persistPage(res: PageResult): Promise<void>;                          // item 6
    getValidators(url: string): Promise<
        { etag?: string; lastModified?: string; contentHash?: string; hasBody: boolean }
        | null>;                                                          // item 8
    getStoredBody(url: string): Promise<
        { body: Uint8Array; contentType?: string; charset?: string } | null>;  // item 8
    progress(stats: CrawlStats): Promise<void>;                           // item 1
    markRunning(): Promise<void>;
    markEnded(end: {
        status: "completed" | "failed" | "stopped";
        stoppedBy?: string;   // CrawlReport.stoppedBy
        error?: string;
        stats?: CrawlStats;   // final snapshot, force-written
    }): Promise<void>;
}
```
- Lazy init: private `#initOnce(hard = false)` guarded by a boolean, awaited at the top
  of **every** public DB method (steve jobs.ts:476-482 pattern). `resetHard()` always
  drops + recreates and re-marks initialized (slightly stronger than steve's, which
  assumes it runs first; behavior is identical in the intended call position).
- `withTransaction` + `isPool`: copy steve's `utils/with-transaction.ts` into
  `src/pg/utils/with-transaction.ts` (steve and cron each carry their own copy — the
  ecosystem precedent is vendoring this 60-liner, not sharing a dep).
- `markRunning()`: `status = 'running'`, `started_at = COALESCE(started_at, NOW())` —
  the COALESCE-first-start idiom from steve/_claim-next.ts:19, so a steve retry-resume
  keeps the original start time.
- Type-only `pg` import throughout; the consumer injects the Pool/Client. `deno.json`
  imports must gain `"pg": "npm:pg@^8.21.0"` and `"@types/pg": "npm:@types/pg@^8.20.0"`
  (steve/deno.json:26-27); `scripts/build-npm.ts` `versionizeDeps([""])` must list them
  (plus page-fetcher) when doc 05's packaging work lands — coordinate, don't duplicate.
- Options snapshot: `createCrawl` stores `input.options` verbatim into `crawl.options`
  JSONB; the caller (doc 02 engine / doc 04 handler) is responsible for passing a
  JSON-safe subset (functions, stores, signals stripped).

**Files** — `src/pg/mod.ts` (exports: `CrawlerPg`, `createCrawlerPg`,
`DEFAULT_TENANT_ID`, row/option types, re-export `Logger`), `src/pg/crawler-pg.ts`,
`src/pg/utils/with-transaction.ts`; `deno.json` (imports + `"./pg"` exports-map entry —
owned by doc 05, referenced here).

**Value/Effort/Risk** — high / M / low. The pattern is proven twice over in steve/cron;
this is careful assembly, not invention.

**Implementation notes** — when `db` is a `pg.Client` (single connection), concurrent
`persistPage` transactions from N workers would interleave BEGIN/COMMIT on one socket.
Guard with an internal promise-chain mutex around `withTransaction` when `!isPool(db)`;
document that a `pg.Pool` is strongly recommended for `concurrency > 1`.

### 5. `PgFrontierStore` / `PgVisitedStore`

**What & why** — PG implementations of doc-02's store interfaces (baseline shapes:
tmp/crawler-DESIGN.md:337-360), bound to one crawl row. The frontier doubles as the
enqueue-dedup set (unique `(crawl_id, url)`); the visited store's cross-run half reads
`__crawler_url` — which is exactly what makes incremental re-crawl work.

**Evidence / reuse**
- steve/src/steve/job/_claim-next.ts:16-30 — the claim shape to model pop on:
  `UPDATE ... WHERE id = (SELECT id ... ORDER BY ... FOR UPDATE SKIP LOCKED LIMIT 1)
  RETURNING *`.
- Store interfaces + `VisitedState` fields: sketch baseline tmp/crawler-DESIGN.md:337-359;
  doc 02 owns the final TS shape and extended it into a claim/ack lifecycle —
  `push(): Promise<boolean>`, `pop({ excludeHosts, now })`, `ack(url)`,
  `release(url, readyAt?)` (doc 02 item 3). Extra structural fields on returned objects
  are compatible.
- Politeness division of labor: page-fetcher has no scheduling; the crawler owns
  per-host capacity/delay (backbone; scheduler design tmp/crawler-DESIGN.md:319-328).

**Spec**
```ts
// src/pg/stores.ts — constructed internally by createCrawl/openCrawl, bound to crawlId
class PgFrontierStore implements FrontierStore { /* doc-02 interface */ }
class PgVisitedStore implements VisitedStore   { /* doc-02 interface */ }
```
> **Corrected in verify:** the draft mapped the design sketch's store surface
> (`pop({ hostsAtCapacity })`, `markDone`); aligned to doc 02's final interface
> (`excludeHosts`, `ack`, plus the previously missing `release`, boolean `push`).

Operation → SQL mapping (frontier):
- `push(item)` — `INSERT ... ON CONFLICT (crawl_id, url) DO NOTHING`. The conflict target
  IS the dedup: a URL enqueues once per run, ever. Returns `rowCount === 1` (doc 02:
  `true` iff inserted — `false` is the duplicate signal). Columns: url, host, depth,
  priority (engine default: `priority = depth` → BFS), discovered_via, referrer, meta,
  ready_at (default NOW; future value = deferred item). `FrontierItem.seq` is not a
  column — the serial `id` reproduces insertion order (the engine pushes serially), so
  `id` stands in for `seq` everywhere ordering matters.
- `pop(filter?: { excludeHosts?: readonly string[]; now?: number })` —
```sql
UPDATE ${t.frontier} SET status = 'in_flight', claimed_at = NOW()
WHERE id = (
    SELECT id FROM ${t.frontier}
    WHERE crawl_id = $1 AND status = 'pending'
      AND ready_at <= NOW()
      AND (cardinality($2::text[]) = 0 OR host <> ALL($2::text[]))
    ORDER BY priority, id
    FOR UPDATE SKIP LOCKED
    LIMIT 1
)
RETURNING *;
```
  `excludeHosts` is the engine's combined exclusion list (per-host concurrency caps
  AND hosts in politeness cool-down) — the store stays policy-free (the `now` param is
  for deterministic memory-store tests; PG uses `NOW()`). `ORDER BY priority, id` =
  pluggable priority with FIFO tiebreak (`id` as `seq`, see push), served by
  `idx_..._pop`; the `ready_at` residual filter is nearly always NOW-satisfied.
- `ack(url)` — `UPDATE ... SET status = 'done' WHERE crawl_id = $1 AND url = $2`;
  normally executed inside the `persistPage` transaction (item 6), exposed standalone
  for skip-after-claim paths.
- `release(url, readyAt?)` — `UPDATE ... SET status = 'pending', claimed_at = NULL,
  ready_at = COALESCE($3, NOW()) WHERE crawl_id = $1 AND url = $2` — returns a claimed
  item to the queue, optionally deferred (politeness back-off after claim).
- `size()` — `SELECT count(*) ... WHERE crawl_id = $1 AND status = 'pending'`.

Visited mapping:
- `has(url)` — `EXISTS` on frontier `(crawl_id, url)`, any status: "already enqueued or
  processed this run". (Enqueue-time dedup is already atomic via push's ON CONFLICT;
  `has` is the cheap pre-check.)
- `get(url)` — `__crawler_url` row for `(tenant_id, url)` LEFT-joined with this run's
  page row; returns `VisitedState` (`status`, `contentHash`, `etag`, `lastModified`,
  `crawledAt`, `attempts`) plus `hasBody: boolean` (`body IS NOT NULL`) for item 8.
- `add(url, state)` — validator-only upsert into `__crawler_url` (etag, last_modified,
  content_hash, last_status, fetched_at; **never** body), PLUS a frontier row
  `INSERT ... status 'done' ON CONFLICT (crawl_id, url) DO NOTHING`. The second insert
  matters for URLs marked visited without ever being enqueued — doc 02's lifecycle adds
  redirect intermediates to the visited store (decision 13), and without a frontier row
  `has()` would miss them and re-enqueue from another referrer. For completed pages the
  row already exists and the insert no-ops. Idempotent overlap with `persistPage`'s url
  upsert is deliberate: stores alone must round-trip `VisitedState` even for an engine
  wired without `persistPage`.
- `count()` — `count(*)` of frontier rows with status `done`.

> **Corrected in verify:** the draft's `add()` wrote only `__crawler_url`, which broke
> `has()` for redirect intermediates (visited per doc 02, never enqueued) — the
> done-row insert above closes that hole.

In-flight recovery (crash/steve-retry): `openCrawl(uid)` runs, before returning stores:
```sql
UPDATE ${t.frontier} SET status = 'pending', claimed_at = NULL
WHERE crawl_id = $1 AND status = 'in_flight';
```
Safe because one crawl = one steve job and steve's claim is exclusive (SKIP LOCKED,
steve/_claim-next.ts:27) — when the handler starts, no legitimate worker can still hold
these rows. The recovered pages get re-fetched; item 6's idempotent upserts absorb the
replay. Caveat for doc 04: steve's autoCleanup default expires jobs `running` > 5 min
(steve/jobs.ts:246-251) — the handler MUST raise `maxAllowedRunDurationMinutes` above the
worst-case crawl duration, or a live crawl gets a second concurrent handler, which this
recovery model explicitly does not support. No mid-run stale-reclaim in v1 (single
process per crawl); the `claimed_at` column exists so a future distributed mode can add a
timeout-based reclaim without schema change (the sketch's "not precluded" requirement,
tmp/crawler-DESIGN.md:34).

**Files** — `src/pg/stores.ts`; `tests/pg-frontier.test.ts` (pop
ordering/exclusion/SKIP LOCKED under two concurrent pops, push dedup, recovery,
visited round-trip).

**Value/Effort/Risk** — high / M / med. Risk: the pop query and the recovery contract
are the two places subtle concurrency bugs can hide; both need direct concurrent tests.

**Implementation notes** — pop with an empty exclusion list must pass `[]` not NULL
(hence the `cardinality($2::text[]) = 0` guard). Frontier rows for a finished crawl are
kept (dedup memory + audit); `deleteCrawl` (item 7) cascades them away.

### 6. Result persistence — `persistPage` writers

**What & why** — as each page completes, write the per-run result row, replace its
outgoing edges, upsert the URL archive (body per `persistBody`), and ack the frontier —
in ONE transaction. Atomicity kills the crash-redo window; idempotency (upserts keyed on
`(crawl_id, url)` + delete-then-insert links) makes steve's retry-the-whole-job model
safe by construction.

**Evidence / reuse**
- `PageResult` / `LinkRecord` field sources: tmp/crawler-DESIGN.md:143-174.
- Body bytes: `FetchResult.bytes()` returns the retained buffer
  (page-fetcher/src/types.ts:182-186); bodies are always fully buffered ≤ `maxBytes`, so
  handing them to a BYTEA param adds no new memory class.
- `@marianmeres/batch` (`BatchFlusher`, batch/src/batch.ts:162) is the allowed candidate
  for buffering — weighed and declined below.

**Spec** — `persistPage(res: PageResult)` runs `withTransaction`:
1. **URL archive upsert** — only when an HTTP response was observed (`res.status`
   present; transport-error pages leave the archive untouched):
```sql
INSERT INTO ${t.url} (tenant_id, url, body, content_type, charset, etag, last_modified,
    content_hash, last_status, size, fetched_at)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
ON CONFLICT (tenant_id, url) DO UPDATE SET
    body = CASE WHEN EXCLUDED.body IS NULL
                  OR ${t.url}.content_hash IS NOT DISTINCT FROM EXCLUDED.content_hash
                THEN ${t.url}.body ELSE EXCLUDED.body END,
    content_type  = COALESCE(EXCLUDED.content_type, ${t.url}.content_type),
    charset       = COALESCE(EXCLUDED.charset, ${t.url}.charset),
    etag          = COALESCE(EXCLUDED.etag, ${t.url}.etag),
    last_modified = COALESCE(EXCLUDED.last_modified, ${t.url}.last_modified),
    content_hash  = COALESCE(EXCLUDED.content_hash, ${t.url}.content_hash),
    last_status   = EXCLUDED.last_status,
    size          = COALESCE(EXCLUDED.size, ${t.url}.size),
    fetched_at    = NOW()
RETURNING id;
```
   The writer passes `body = NULL` when: response not ok, no body retained, or the
   `persistBody` option (boolean or `(res) => boolean` predicate, default `true`) says
   no. The CASE then keeps the previous body — the archive holds the *last good* body
   plus the *last observed* status/validators. Unchanged hash keeps the old column value
   (preserves the TOAST pointer — no large-value rewrite). A 304 goes through the same
   statement with everything NULL except status → "touches fetched_at only" exactly as
   specified.
2. **Page upsert** — full column set from `PageResult` (+ `url_id` from step 1,
   `tenant_id`, `crawl_id`), `ON CONFLICT (crawl_id, url) DO UPDATE SET` every mutable
   column — the replay path after in-flight recovery.
   `data` is the `onPage` return value: it MUST be plain JSON-serializable data
   (node-postgres serializes it via `JSON.stringify`; `BigInt` throws, `undefined`/
   functions silently vanish). Document this constraint in the `persistPage` JSDoc and
   the README scraping recipe. Defensive rule (doc 02's open question, resolved here):
   `persistPage` pre-checks with a guarded `JSON.stringify(data)`; on throw it stores
   `NULL`, logs one `logger?.warn` with the URL, and never fails the page write — a bad
   `onPage` return must not kill a crawl.
3. **Link replace** — `DELETE FROM ${t.link} WHERE crawl_id = $1 AND from_url = $2`,
   then one multi-row `INSERT ... SELECT ... FROM UNNEST($arrays...)` for
   `res.links` (a single statement regardless of link count). Delete-then-insert keeps
   the replay idempotent without a per-edge unique key (duplicate identical anchors on a
   page are legitimate data).
4. **Frontier ack** — the `ack` UPDATE from item 5, same transaction.

**Batch decision** — single per-page transaction, **no** `BatchFlusher` in v1:
- Throughput is politeness-bound: with default `concurrency: 5` and per-host delays the
  steady state is a few pages/sec — tens of small statements/sec, three orders of
  magnitude under PG's comfort zone. The one per-page hot spot (many link rows) is
  already solved by the single UNNEST insert.
- Cross-page buffering must buffer frontier acks too (an ack committed before its result
  loses the page permanently), so a batch is only correct if flushed as one atomic unit —
  all complexity, no measured need. Revisit inside `./pg` only with profiling evidence;
  decision 15 keeps that door open.

**Files** — `src/pg/persist.ts` (+ wiring in `crawler-pg.ts`);
`tests/pg-persist-query.test.ts` (body replace/keep matrix incl. 304 and non-ok, replay
idempotency: `persistPage` twice → identical rows, link replace, `persistBody` predicate).

**Value/Effort/Risk** — high / M / med. Risk: the body CASE/COALESCE matrix is easy to
get subtly wrong — the test matrix above is not optional.

**Implementation notes** — wrap body bytes as `Buffer.from(u8)` for node-postgres BYTEA
params (works on Deno via node:buffer). Timing lands as the sketch's
`{ total, fetch, extract }` object in the `timing` JSONB.

### 7. Consumer query / reporting API

**What & why** — the owner's per-URL reporting requirement: while steve rows are queue
plumbing, the crawler tables are the reporting surface. This item gives consumers precise
methods for the standard questions (what ran, what failed, what's broken, what changed,
give me the body) without hand-written SQL.

**Evidence / reuse**
- Broken-link reporting rationale — edges enable "which page contains the dead link":
  tmp/crawler-DESIGN.md:185-186; recipe #1 tmp/crawler-DESIGN.md:413-414.
- Live stats come from item 1's throttled writes; `CrawlStats` shape
  tmp/crawler-DESIGN.md:389-399.

**Spec** — methods on `CrawlerPg` (all tenant-scoped by the instance's `tenantId`; all
`await #initOnce()` first). Row types are camelCase mappings of item 3's columns,
exported from `./pg` (`CrawlRow`, `PageRow`, `LinkRow`, `UrlRow`):
```ts
getCrawl(uid: string): Promise<CrawlRow | null>;
listCrawls(opts?: { status?: CrawlRow["status"]; limit?: number; offset?: number }):
    Promise<CrawlRow[]>;                       // newest first (idx tenant_id, created_at DESC)
crawlStats(uid: string): Promise<CrawlStats | null>;   // SELECT stats — the cheap poll
listPages(uid: string, opts?: {
    ok?: boolean; status?: number | number[]; notModified?: boolean;
    skipped?: boolean;                         // skip_reason IS (NOT) NULL
    limit?: number; offset?: number;
}): Promise<PageRow[]>;
listFailed(uid: string, opts?: { limit?: number; offset?: number }): Promise<PageRow[]>;
    // sugar: NOT ok AND skip_reason IS NULL (errors + bad statuses, not policy skips)
listLinks(uid: string, opts?: {
    kind?: "internal" | "external"; rel?: string; followed?: boolean;
    skipReason?: string; toUrl?: string; limit?: number; offset?: number;
}): Promise<LinkRow[]>;
brokenLinks(uid: string): Promise<Array<{
    toUrl: string; status: number | null; errorKind?: string; fromUrls: string[];
}>>;
getBody(url: string): Promise<{
    body: Uint8Array; contentType?: string; charset?: string; contentHash?: string;
    etag?: string; lastModified?: string; fetchedAt: Date;
} | null>;                                     // exact normalized-URL match (see notes)
listChanged(uid: string, opts?: { against?: string }): Promise<Array<{
    url: string; change: "new" | "changed" | "removed";
    contentHash?: string; previousHash?: string;
}>>;
deleteCrawl(uid: string): Promise<boolean>;    // DELETE crawl row; FKs cascade
getCrawlByJobUid(jobUid: string): Promise<CrawlRow | null>;
    // job-mode lookup (doc 04): SELECT ... WHERE tenant_id = $1 AND job_uid = $2,
    // served by item 3's partial index on job_uid
recomputeStats(uid: string): Promise<CrawlStats>;
    // rebuild the counters (done/failed/skipped/bytes/byStatus) from __crawler_page +
    // __crawler_frontier rows and force-write the crawl row's stats JSONB; doc 04 calls
    // this at the start of a crash-resumed job attempt so onProgress deltas start from
    // truth instead of the stale pre-crash snapshot
```
- `brokenLinks` joins edges to the target's page row **in the same run**:
```sql
SELECT l.to_url, p.status, p.error_kind,
       array_agg(DISTINCT l.from_url ORDER BY l.from_url) AS from_urls
FROM ${t.link} l
JOIN ${t.page} p ON p.crawl_id = l.crawl_id AND p.url = l.to_url
WHERE l.crawl_id = $1 AND NOT p.ok AND p.skip_reason IS NULL
GROUP BY l.to_url, p.status, p.error_kind
ORDER BY count(*) DESC, l.to_url;
```
  Only targets that were actually visited/checked appear — the broken-link recipe needs
  assets on and `checkExternal: true` (tmp/crawler-DESIGN.md:276-277) to cover
  externals; say so in the method JSDoc.
- `listChanged` diffs per-run `content_hash` (the reason page rows carry their own copy):
```sql
WITH cur AS (SELECT url, content_hash FROM ${t.page}
             WHERE crawl_id = $1 AND ok AND skip_reason IS NULL),
     prev AS (SELECT url, content_hash FROM ${t.page}
              WHERE crawl_id = $2 AND ok AND skip_reason IS NULL)
SELECT COALESCE(c.url, p.url) AS url,
       CASE WHEN p.url IS NULL THEN 'new'
            WHEN c.url IS NULL THEN 'removed'
            ELSE 'changed' END AS change,
       c.content_hash, p.content_hash AS previous_hash
FROM cur c FULL OUTER JOIN prev p USING (url)
WHERE p.url IS NULL OR c.url IS NULL
   OR c.content_hash IS DISTINCT FROM p.content_hash;
```
  Default `against`: the latest earlier `completed` crawl of the same tenant
  (`created_at` DESC LIMIT 1); explicit `opts.against` overrides. JSDoc caveat:
  `"removed"` also fires when scope/options narrowed between runs — it means "not in
  this run", not "gone from the site".

**Files** — `src/pg/query.ts` (+ `crawler-pg.ts` wiring);
`tests/pg-persist-query.test.ts`.

**Value/Effort/Risk** — high / M / low. Straight SQL over item 3's indexes; the only
subtlety is the two documented caveats.

**Implementation notes** — `getBody` matches the stored normalized URL exactly; it does
not re-normalize input (normalization options are per-crawl and unknown here). Document:
"pass the `url` field of a `PageRow`/`PageResult`". Pagination defaults: `limit 100`,
hard cap 1000, `ORDER BY id`.

### 8. Incremental re-crawl mechanics (validators, 304 path)

**What & why** — a re-crawl against a populated `__crawler_url` should be mostly 304s:
seed `If-None-Match`/`If-Modified-Since` from the stored validators, treat a 304 as
"unchanged", and still traverse the site without re-downloading it. This is the payoff of
the URL-keyed archive and the headline of the incremental recipe
(tmp/crawler-DESIGN.md:369-371).

**Evidence / reuse**
- page-fetcher's cache layer steps aside for caller-managed conditionals: requests
  carrying `if-none-match`/`if-modified-since` (or `range`) bypass it entirely
  (page-fetcher/src/cache/layer.ts:41 `BYPASS_HEADERS`) — the 304 reaches the crawler as
  a real result, no double-caching.
- `FetchRequest.headers` merge over adapter defaults (page-fetcher/src/types.ts:79-80);
  `FetchResult.notModified` flags the cache-resolved case, a manual-conditional 304 is
  simply `status: 304`, `hasBody: false` (types.ts:155-207).

**Spec**
- **Seeding**: before fetching a URL, the engine asks `getValidators(url)` (item 4;
  backed by `__crawler_url`). A store-driven engine gets the same data from
  `visited.get()` — the PG store returns `hasBody` alongside `VisitedState` (item 5)
  precisely so doc 02's recrawl wiring can apply the rule below without a PG-specific
  code path. Rule: send validators **only when `hasBody` is true** —
  i.e. only when the archive can answer the "unchanged" case locally. A URL with
  validators but no stored body (persistBody predicate said no, or archive pruned) is
  fetched unconditionally. This one rule removes every "304 but nothing to fall back on"
  corner.
- **On 304**: write the page row with `status = 304`, `ok = true`,
  `not_modified = true`, `content_hash` copied from the url row; url row gets the
  fetched_at-only touch (item 6). Emit `onPageDone` normally.
- **Outlinks on 304 — decision: re-extract from the stored body.** Alternatives weighed:
  - *Copy previous run's `__crawler_link` rows*: cheap, but "previous run" is ambiguous,
    and the copied `followed`/`skip_reason` flags were computed under possibly different
    scope/extract options — silently wrong after any option change.
  - *Re-extract from `__crawler_url.body`* (chosen): the 304 guarantees the stored bytes
    are the current content; `extractLinks` is pure CPU (microseconds against a network
    round-trip saved), and classification/scope run under the CURRENT options — always
    correct. The validator-seeding rule above guarantees the body is present whenever a
    304 can occur.
  Flow: `getStoredBody(url)` (item 4) → decode per stored charset → `extractLinks` →
  normal enqueue/link pipeline → link replace writes fresh edges for this run.
- **Change reporting**: `listChanged` (item 7) closes the recipe: fetched-and-different
  pages get a new per-run hash; 304/hash-identical pages don't.
- Recipe doc (README, owned by doc 05): PG mode + `respectRobots` defaults + this
  mechanism — "re-crawl weekly, alert on `listChanged`".

**Files** — engine-side seeding hooks belong to doc 02/04 wiring; this item lands
`getValidators`/`getStoredBody` (in `src/pg/persist.ts` or `query.ts`) and
`tests/pg-incremental.test.ts` (validator seeding rule, 304 write path, re-extract
fallback matrix).

**Value/Effort/Risk** — high / M / med. Risk: the ok/304 semantics must stay consistent
between page-fetcher's result shape and the page-row writer; the test matrix pins it.

**Implementation notes** — send both validators when both exist (RFC-conformant servers
prefer `If-None-Match`). Store header values verbatim (item 3 columns are TEXT for that
reason) — never parse/reformat dates. Decode the stored body with the stored `charset`
via `TextDecoder`, defaulting to `utf-8`.

## Open questions / decisions needed

1. **Archive growth/pruning** — `__crawler_url` grows monotonically across all runs and
   tenants (bounded per row by page-fetcher's `maxBytes`, unbounded in row count). v1
   ships no TTL/prune helper; is a `pruneUrls({ olderThan?, host? })` maintenance method
   wanted, or is "consumer runs DELETE" acceptable? (Data-loss policy — owner call, not
   blocking implementation.)
2. **Cross-tenant body sharing** — the archive is tenant-scoped (`(tenant_id, url)`
   unique), so two tenants crawling the same site store the body twice. Almost certainly
   correct for isolation; flagging so it is chosen, not accidental.
