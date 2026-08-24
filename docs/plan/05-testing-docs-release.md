<!--
GENERATED ANALYSIS — @marianmeres/crawler implementation plan
Produced 2026-08-24 by multi-agent research -> adversarial verify -> synthesize.
Claims verified against ecosystem package working trees (page-fetcher v0.4.0, steve v3.0.0,
cron v3.2.0, clog v3.21.0). The crawler repo itself is a pre-first-commit scaffold.
Planning artifact; no code was changed.
-->

# Testing Strategy, Docs, Packaging & Release

> This doc covers everything that makes the package shippable: the test pyramid, the
> deno.json/npm packaging fixes, the documentation set, the shipped recipes, and the
> release flow. The architecture lives in docs 01–04; this is checklists and conventions.
>
> The single most important takeaway: **no test ever touches the network**. The bulk of
> the suite is pure unit tests over `./url` and `./extract`; the engine is tested against
> an injected fake `FetchFn` serving a fixture mini-site defined as a plain data
> structure; PG and steve tests are env-gated integration tests in the exact steve/cron
> style.
>
> Headline packaging finding: the scaffold ships broken as-is. `deno.json` has no
> `publish.exclude` block (tests/scripts/docs would all go to JSR), `exports` is a
> single string, and `scripts/build-npm.ts` passes `versionizeDeps([""])` — the npm
> package would declare **zero** runtime dependencies while importing
> `@marianmeres/page-fetcher`, which breaks every node consumer. The retired prior art
> was consumed via npm (nettle-crawler deno.json:9 publishes to npm; its
> scripts/build-npm.ts:9 carries a real dependency list), so the npm path is not
> optional polish — it must actually work.

## Summary of work items

| # | Work item                                                | Value | Effort | Risk |
| - | -------------------------------------------------------- | ----- | ------ | ---- |
| 1 | deno.json: exports map, imports, publish exclude, tasks   | high  | S      | low  |
| 2 | scripts/build-npm.ts: entry points + real dependency list | high  | S      | med  |
| 3 | Fake fetcher helper + fixture mini-site + engine tests    | high  | M      | med  |
| 4 | PG integration tests (TEST_PG_* gated, steve/cron style)  | high  | M      | low  |
| 5 | Documentation set: README, AGENTS.md, .env.example        | high  | M      | low  |
| 6 | Pure unit suites for ./url and ./extract (fixture corpora)| high  | L      | low  |
| 7 | Steve end-to-end test (enqueue → worker → poll → query)   | med   | S      | med  |
| 8 | Release flow: checklist, dry-runs, rp/rpm; mcp.ts backlog | med   | S      | low  |
| 9 | Recipes/examples dir (6 recipes, doubling as tests)       | med   | M      | low  |

## Work items (detailed)

### 1. deno.json: exports map, imports, publish exclude, tasks

**What & why** — The scaffold's `deno.json` has `"exports": "./src/mod.ts"` as a single
string (deno.json:4) and **no** `publish` block, so `tests/`, `scripts/` and `docs/`
would all ship to JSR (`tmp/` is gitignored, which `deno publish` already respects — the
`tmp/**` exclude entry below is belt-and-braces only). It also lacks every dependency the
package needs and its `test` task (deno.json:6) misses `-A --env-file` required by the
PG tests.

> **Cut from the draft:** the claim that `tmp/` would ship to JSR — `.gitignore` has
> `tmp/*` and `deno publish` honors it.

**Evidence / reuse** —
- Publish-exclude precedent: page-fetcher/deno.json:9-16 (`".*"`, `tests/**`,
  `example/**`).
- Self-name import maps so tests/examples import by package name:
  page-fetcher/deno.json:37-39.
- pg + @types/pg living in `imports` while runtime injection stays consumer-side
  (deno.json has no optional-deps concept; type-only usage is the convention):
  steve/deno.json:26-27, cron/deno.json:24-25.
- Test task shape `deno test -A --env-file`: steve/deno.json:6, cron/deno.json:6.
- `@std/testing` (FakeTime) as a dev-only import: page-fetcher/deno.json:47.

**Spec** — final `deno.json` deltas (everything else stays, fmt untouched):

```jsonc
"exports": {
	".":         "./src/mod.ts",
	"./url":     "./src/url/mod.ts",
	"./extract": "./src/extract/mod.ts",
	"./stores":  "./src/stores/mod.ts",
	"./pg":      "./src/pg/mod.ts",
	"./steve":   "./src/steve/mod.ts"
},
"publish": {
	"exclude": [".*", "tests/**", "examples/**", "docs/**", "scripts/**", "tmp/**"]
},
"tasks": {
	"test": "deno test -A --env-file",
	"test:watch": "deno test -A --env-file --watch"
	// npm:*, release, publish, rp, rpm stay as scaffolded
},
"imports": {
	// self-map — tests, examples and recipes import by public name
	"@marianmeres/crawler": "./src/mod.ts",
	"@marianmeres/crawler/url": "./src/url/mod.ts",
	"@marianmeres/crawler/extract": "./src/extract/mod.ts",
	"@marianmeres/crawler/stores": "./src/stores/mod.ts",
	"@marianmeres/crawler/pg": "./src/pg/mod.ts",
	"@marianmeres/crawler/steve": "./src/steve/mod.ts",
	// runtime
	"@marianmeres/page-fetcher": "jsr:@marianmeres/page-fetcher@^0.4.0",
	// type-only used (Logger / pg.Pool|Client / steve Job types) — steve/cron precedent
	"@marianmeres/clog": "jsr:@marianmeres/clog@^3.21.0",
	"@marianmeres/steve": "jsr:@marianmeres/steve@^3.0.0",
	"pg": "npm:pg@^8.23.0",
	"@types/pg": "npm:@types/pg@^8.23.1",
	// tests only
	"@std/testing": "jsr:@std/testing@^1.0.18"
	// keep the scaffold's npmbuild/@std/* entries
}
```

Note: `".*"` in the exclude covers `.env*`, `.editorconfig`, `.gitignore`. `pg` is
imported with `import type` only, everywhere (owner decision 8/15) — importing `"."`,
`"./url"` or `"./extract"` never pulls pg/steve at runtime.

**Files** — modify `/Users/mm/projects/@marianmeres/crawler/deno.json`.

**Value/Effort/Risk** — high/S/low; pure config, but everything (tests, publish, npm
build) depends on it — do it first.

**Implementation notes** — Verify with `deno publish --dry-run` that the file list
contains only `src/**`, `LICENSE`, `README.md`, `deno.json` (+AGENTS.md once written).
Keep exact version pins in sync with the published JSR/npm versions at implementation
time (steve must be on JSR/npm at ^3, else fall back to matching the published major).

### 2. scripts/build-npm.ts: entry points + real dependency list

**What & why** — The scaffold passes `versionizeDeps([""], denoJson)`
(crawler scripts/build-npm.ts:9), i.e. no runtime deps at all, and no `entryPoints`,
i.e. only `"."` would be exported. The npm package must expose all six entry points and
declare `@marianmeres/page-fetcher` for real — node consumers exist (the prior art
published to npm: nettle-crawler/deno.json:9, with a full dep list in its
scripts/build-npm.ts:9).

**Evidence / reuse** —
- `versionizeDeps` maps bare names to `name@^version` from deno.json imports:
  npmbuild/npm-build.ts:87-104.
- `dependencies: string[]` entries are npm-installed at build time (so `tsc` resolves
  them) and written to package.json: npmbuild/npm-build.ts:129-140.
- `peerDependencies: string[]` are installed `--no-save` for the tsc pass but emitted as
  peers only; `peerDependenciesMeta` emitted verbatim: npmbuild/npm-build.ts:141-167.
  Optional-peer precedent with rationale comment: cron/scripts/build-npm.ts:21-27.
- `entryPoints` expects a flat `src/{name}.ts` per entry and generates `"./{name}"`
  exports: npmbuild/npm-build.ts:172-176 and 356-364. Precedent incl. the "type-only dep
  still needed for .d.ts resolution" note: page-fetcher/scripts/build-npm.ts:9-13.
- `rootFiles` defaults include `"docs"` (npmbuild/npm-build.ts:222-229) — that would ship
  `docs/plan/` into the npm tarball; override it.

**Spec** —

Because npmbuild entry points must be flat `src/{name}.ts` files while the deno exports
map points at `src/{name}/mod.ts`, add one-line re-export shims (they also ship to JSR,
harmlessly):

```ts
// src/url.ts (same pattern: extract.ts, stores.ts, pg.ts, steve.ts)
export * from "./url/mod.ts";
```

```ts
// scripts/build-npm.ts
import { npmBuild, versionizeDeps } from "@marianmeres/npmbuild";

const denoJson = JSON.parse(Deno.readTextFileSync("deno.json"));

await npmBuild({
	name: denoJson.name,
	version: denoJson.version,
	repository: denoJson.name.replace(/^@/, ""),
	// keep in sync with deno.json "exports" (npmbuild maps "mod" -> ".", "x" -> "./x")
	entryPoints: ["mod", "url", "extract", "stores", "pg", "steve"],
	// page-fetcher is the real runtime dep; clog is type-only but the emitted .d.ts
	// references it, so consumers' tsc must resolve it (page-fetcher precedent)
	dependencies: versionizeDeps(
		["@marianmeres/page-fetcher", "@marianmeres/clog"],
		denoJson,
	),
	// only the "./pg" and "./steve" entry .d.ts files reference these; consumers who
	// never import those subpaths never need them. npm does not auto-install optional
	// peers — the README says to act on it (cron/ajv precedent).
	peerDependencies: versionizeDeps(["pg", "@types/pg", "@marianmeres/steve"], denoJson),
	peerDependenciesMeta: {
		"pg": { optional: true },
		"@types/pg": { optional: true },
		"@marianmeres/steve": { optional: true },
	},
	// default rootFiles would ship docs/ (incl. docs/plan) — don't
	rootFiles: ["LICENSE", "README.md", "AGENTS.md"],
});
```

**Files** — modify `/Users/mm/projects/@marianmeres/crawler/scripts/build-npm.ts`;
create `/Users/mm/projects/@marianmeres/crawler/src/url.ts`, `src/extract.ts`,
`src/stores.ts`, `src/pg.ts`, `src/steve.ts` (shims).

**Value/Effort/Risk** — high/S/med; risk is the shim/exports drift and the peer-dep
choice — mitigated by the "keep in sync" comment and a release-time `npm:build` dry run
(item 8).

**Implementation notes** — After `deno task npm:build`, inspect
`.npm-dist/package.json`: 6 export keys, `dependencies` = page-fetcher + clog,
`peerDependencies` = pg/@types/pg/steve all optional. Steve-as-peer only matters once
doc 04's `./steve` entry emits its types; if the type surface ends up fully local,
drop it from the peer list rather than declaring a dead peer.

### 3. Fake fetcher helper + fixture mini-site + engine tests

**What & why** — Engine tests (crawl loop, scheduling, budgets, events) run with memory
stores and an injected fake `FetchFn` — zero sockets, fully deterministic. page-fetcher
already solved "fabricate a complete FetchResult without network" for its own tests, but
its helpers are unpublished test code using internals
(page-fetcher/tests/helpers.ts:10 imports `../src/internal.ts`), so the crawler carries
its own small copy.

**Evidence / reuse** —
- `FetchFn = (req: FetchRequest) => Promise<FetchResult>`: page-fetcher/src/types.ts:49.
- Full `FetchResult` shape to fabricate: page-fetcher/src/types.ts:155-207;
  `retainBody:false` semantics types.ts:103-108; `meta` echo types.ts:118-119.
- Model: `makeResult` (page-fetcher/tests/helpers.ts:24-57), `scriptedFetch` with
  recorded `calls` (helpers.ts:85-96), `recordingLogger` (helpers.ts:159-176).

**Spec** — `tests/_helpers.ts`:

```ts
import type { FetchFn, FetchRequest, FetchResult, Logger } from "@marianmeres/page-fetcher";

/** One canned page of the fixture site. */
export interface FakePage {
	status?: number; // default 200
	contentType?: string; // default "text/html"
	html?: string; // body ("" default)
	headers?: Record<string, string>;
	redirectTo?: string; // 301 → chain is followed, redirects[]/finalUrl synthesized
}
/** Absolute URL → page. Includes robots.txt / sitemap.xml entries like any URL. */
export type MiniSite = Record<string, FakePage>;

/** Complete FetchResult from parts — no network, no page-fetcher internals. */
export function makeResult(
	init: Partial<Omit<FetchResult, "text" | "bytes" | "headers">> & {
		url: string;
		body?: string;
		headers?: HeadersInit;
	},
): FetchResult;

/** FetchFn over a MiniSite: unknown URL → 404; records every request. */
export function siteFetch(site: MiniSite): FetchFn & { calls: FetchRequest[] };

/** clog-shaped recording logger (records instead of printing). */
export function recordingLogger(): Logger & { messages(level?: string): string[] };
```

`siteFetch` behavior: exact-string lookup of `req.url`; follows `redirectTo` chains
(cap 10) accumulating `redirects[]` and `finalUrl`; body accessors are closures over the
fixture string (`text: () => Promise.resolve(html)`, `bytes` via `TextEncoder`);
`hasBody:false` when `retainBody === false`; echoes `req.meta`; `size` = byte length;
`attempts: 1`, `adapter: "fake"`, zeroed `timing`. It never sleeps and never throws
unless a step is scripted to.

Shared fixture `SMALL_SITE` (same file, ~12 entries on `http://site.test`): `/` linking
`/a` `/b` `/dup?utm_source=x` `/redirect` `/private/secret` and `http://ext.test/x`;
`/a` ↔ `/b` cycle; `/dup` reachable clean and tracked (normalization dedupe); `/redirect`
→ `/target`; `/robots.txt` disallowing `/private/` with `Sitemap:` line; `/sitemap.xml`
listing `/sitemap-only`; a `/t/a/b/a/b/a/b` repeated-segment trap.

Engine test files (each states its assertions against `SMALL_SITE` unless noted):
- `tests/crawler.test.ts` — `crawl()` report shape; BFS order and depth-from-seed;
  dedupe via normalization (`/dup` fetched once); redirect recorded as attribute,
  intermediate marked visited; `for await` streaming with early `break`.
- `tests/crawler-limits.test.ts` — maxPages, maxDepth, maxTotalBytes, `stoppedBy`;
  maxDuration with a delayed-fetch step (real ~10 ms delays, no fake timers needed).
- `tests/crawler-scope-robots.test.ts` — same-host default (ext.test recorded, not
  visited, `skipReason: "out-of-scope"`); robots disallow honored + skip recorded;
  `respectRobots: false` warns exactly once (recordingLogger); 5xx robots →
  disallow-all.
- `tests/crawler-politeness.test.ts` — instrument `siteFetch` with in-flight counters:
  global and per-host concurrency never exceeded; perHostDelay spacing between
  same-host call timestamps (generous tolerance, no exact-timing asserts).
- `tests/crawler-events.test.ts` — event ordering (onStart … onEnd); a throwing handler
  never breaks the crawl (safeEmit); `stop()` drains, `abort()`/signal cancels;
  `onLinkSkipped` fires for every skip.

**Files** — create `/Users/mm/projects/@marianmeres/crawler/tests/_helpers.ts` and the 5
test files above; delete the scaffold placeholder
`/Users/mm/projects/@marianmeres/crawler/tests/crawler.test.ts` content in favor of the
real suite.

**Value/Effort/Risk** — high/M/med; the only real risk is timing-flaky politeness
asserts — keep tolerances loose and assert invariants (never-exceeded, ordering) rather
than exact durations.

**Implementation notes** — No test may construct a real fetcher; the engine receives
`fetcher: siteFetch(SMALL_SITE)` directly (plain `FetchFn` is an accepted option per
owner decision 10). Assert `fake.calls` covers exactly the expected URL set — that
doubles as the no-network proof.

### 4. PG integration tests (TEST_PG_* gated, steve/cron style)

**What & why** — The `./pg` stores and persistence (doc 03) need tests against a live
PG, following the ecosystem pattern exactly so the workflow is identical across
steve/cron/crawler.

**Evidence / reuse** —
- `tests/_pg.ts` with `TEST_PG_*` env + `createPg(): pg.Pool`: steve/tests/_pg.ts:3-19
  (copy verbatim).
- Per-test `resetHard()` setup/teardown and `_test_` prefix:
  cron/tests/cron-db.test.ts:25 and 66-78; run instructions header
  cron/tests/cron-db.test.ts:1-8 (`deno test -A --env-file`).
- Silent logger in tests: `createNoopClog` exists (clog/src/clog.ts:911) — or the
  recordingLogger from item 3.

**Spec** —
- `tests/_pg.ts` — verbatim steve copy.
- Gating (deliberate deviation from steve/cron, which fail hard without a DB — this
  package is memory-first and the suite must stay green without PG):

```ts
const hasPg = !!Deno.env.get("TEST_PG_DATABASE");
Deno.test({ name: "pg: …", ignore: !hasPg }, async () => { /* … */ });
```

- `tests/pg-stores.test.ts` — frontier: push/pop ordering by priority/depth, `ready_at`
  delay honored, `pending → in_flight → done` transitions, two concurrent pops never
  return the same row (FOR UPDATE SKIP LOCKED); visited: has/add/get/count, tenant
  isolation (`tenant_id` default `'_default'`); schema init idempotent (call twice),
  `resetHard()` twice does not throw (cron test 1 precedent,
  cron/tests/cron-db.test.ts:85-93).
- `tests/pg-persistence.test.ts` — full crawl of `SMALL_SITE` via `siteFetch` into PG
  stores + persistence, `_test_` prefix: crawl row lifecycle
  pending→running→completed with live stats JSONB updated; page rows per fetched URL
  (depth, discovered_via, skip info); link rows = the graph incl. skipped edges; url
  archive is latest-per-URL — re-crawl with changed body replaces the row (content_hash
  change), unchanged body does not; `persistBody: false` and predicate leave `body`
  NULL; bodies land in `__crawler_url`, never anywhere JSONB.

Every test: `const db = createPg()` … `await db.end()` in `finally`; fresh
`resetHard()` in setup. Table prefix constant `"_test_"`.

**Files** — create `/Users/mm/projects/@marianmeres/crawler/tests/_pg.ts`,
`tests/pg-stores.test.ts`, `tests/pg-persistence.test.ts`.

**Value/Effort/Risk** — high/M/low; pattern is proven in two sibling packages.

**Implementation notes** — Reuse `SMALL_SITE`/`siteFetch` from item 3 — PG tests are
still network-free; only the DB is real. Keep each test self-contained (own reset), no
cross-test ordering.

### 5. Documentation set: README, AGENTS.md, .env.example

**What & why** — Ship the standard ecosystem doc pair plus test env template. The README
is the human contract; AGENTS.md the agent-facing one. Several behaviors are
documentation-mandatory per owner decisions and would otherwise bite users silently.

**Evidence / reuse** —
- Author per the guides (reference, do not inline):
  `/Users/mm/projects/@marianmeres/agents/mm-local-docs/HUMAN_DOCUMENTATION_GUIDE.md`
  (README) and
  `/Users/mm/projects/@marianmeres/agents/mm-local-docs/AGENT_DOCUMENTATION_GUIDE.md`
  (AGENTS.md).
- Reaper fact to document: steve `AutoCleanupOptions` expires jobs `running` > 5 min by
  default (steve/src/steve/jobs.ts:246-251); handler contract steve jobs.ts:78-81.
- `.env.example` template: steve/.env.example `TEST_PG_*` block; the scaffold's current
  file is a one-line placeholder.

**Spec** — README must contain (beyond the guide's standard structure):
- The foundation split: transport = page-fetcher, crawling = this package; the
  **retry-layering rule** verbatim (page-fetcher retries per request; the crawler never
  adds per-page retry; steve retries whole crashed jobs — safe because PG state
  resumes).
- Layered modes: memory default, `./pg` opt-in, never PG-only; npm users of `./pg` /
  `./steve` must install the optional peers (item 2).
- **same-site caveat**: `"same-site"` scoping uses a small multi-label-TLD heuristic,
  not the full Public Suffix List; PSL injectable; default `"same-host"` is unaffected.
- **robots opt-out**: `respectRobots: false` exists for own/staging sites and logs one
  warning; 4xx/failed robots = allow-all, 5xx = disallow-all.
- **steve guidance box**: one crawl = one job; raise
  `autoCleanup.maxAllowedRunDurationMinutes` (default 5) for crawls longer than
  minutes; live progress is read from the crawl-run row, not from steve (steve has no
  mid-run progress API); bodies are never in the steve result JSONB.
- Browser crawling = injected driver (Playwright/Puppeteer are never dependencies);
  `maxTotalBytes` vs page-fetcher's per-request `maxBytes`; `persistBody` option;
  private-host guard default (permissive) and how to tighten it.

AGENTS.md: per the agent guide — module map (6 entries), store interfaces, PG table set
with prefix convention, the owner-decision invariants above in agent-consumable form.

`.env.example`:

```
# FOR POSTGRES (USED IN TESTS ONLY)
TEST_PG_HOST=localhost
TEST_PG_DATABASE=crawler_test
TEST_PG_USER=
TEST_PG_PASSWORD=
TEST_PG_PORT=5432
```

**Files** — rewrite `/Users/mm/projects/@marianmeres/crawler/README.md` and
`/Users/mm/projects/@marianmeres/crawler/.env.example`; create
`/Users/mm/projects/@marianmeres/crawler/AGENTS.md`.

**Value/Effort/Risk** — high/M/low; content is fully determined by docs 01–04 + the
decision list.

**Implementation notes** — Write after the API stabilizes (docs 02–04 implemented);
follow the guides' structure rather than inventing one. Never mention private `stack-*`
packages anywhere in these files.

### 6. Pure unit suites for ./url and ./extract (fixture corpora)

**What & why** — `normalizeUrl` defines dedup correctness and `extractLinks` must never
throw on garbage — these two submodules carry the bulk of the test suite (design sketch:
implement `normalizeUrl` + full unit suite first, tmp/crawler-DESIGN.md:442-444).

**Evidence / reuse** — Design sketch binding requirements: idempotence
`normalize(normalize(x)) === normalize(x)` is a required test
(tmp/crawler-DESIGN.md:208-210); the full normalization pipeline steps
(tmp/crawler-DESIGN.md:199-221); extraction source table and never-throw rule
(tmp/crawler-DESIGN.md:241-263). No ecosystem package provides any of this — greenfield.

**Spec** — All tests import only via the standalone entries
(`@marianmeres/crawler/url`, `@marianmeres/crawler/extract` self-imports from item 1) —
that proves the zero-dep/standalone contract. Table-driven cases as
`{ name, input, base?, opts?, expect }[]`; larger messy HTML lives in
`tests/fixtures/html/*.html` read with `Deno.readTextFileSync` (fine under `-A`).

- `tests/url-normalize.test.ts` — per-pipeline-step cases (scheme/host lowercase, port
  strip, fragment, dot-segments, duplicate slashes, trailing-slash policy incl. root,
  tracking-param blocklist, param sort, punycode/IDN, length cap, non-fetchable scheme
  rejection → `null`); base resolution incl. `<base href>` over finalUrl; **property
  test**: idempotence over the entire case corpus (every expected output re-normalizes
  to itself); every toggle in `NormalizeOptions` exercised on at least one case.
- `tests/url-same-site.test.ts` — heuristic multi-label TLDs (`co.uk`, `gov.sk`,
  `com.au`), subdomain modes `same-host`/`same-site`/`any`, injected PSL override
  changing a verdict, IP-literal and localhost hosts.
- `tests/url-classify.test.ts` — internal/external/asset classification vs a base.
- `tests/extract-links.test.ts` — corpus fixtures: clean page; unquoted/single-quoted
  attrs; uppercase tags; `<base href>`; `<meta http-equiv=refresh>`; canonical /
  next/prev; nofollow/ugc/sponsored rel parsing; anchor-text trim/collapse/cap; iframe
  and asset sources behind their toggles; srcset candidates; links inside comments and
  CDATA (must NOT be extracted); truncated tags and binary junk (must not throw —
  dedicated never-throw test feeding random bytes).
- `tests/extract-robots.test.ts` — UA group matching, Allow/Disallow longest-match, `*`
  and `$` wildcards, Crawl-delay, `Sitemap:` lines, empty/comment-only files.
- `tests/extract-sitemap.test.ts` — urlset, sitemapindex nesting, lastmod parse,
  malformed XML tolerance (skip bad entries, never throw).
- `tests/extract-meta-robots.test.ts` — meta robots + `X-Robots-Tag` header values
  (`noindex`, `nofollow`, combined, casing, multiple headers).

**Files** — create the 7 test files above plus
`/Users/mm/projects/@marianmeres/crawler/tests/fixtures/html/` (~6–10 small .html
fixtures).

**Value/Effort/Risk** — high/L/low; large but mechanical — the corpus IS the spec of
`./url`/`./extract`, so write it alongside doc 01's implementation, not after.

**Implementation notes** — Keep fixtures small and named for the pathology they encode
(`unquoted-attrs.html`, `base-href.html`, …). When a normalization judgment call is made
(trailing slash, `www.`), encode the decision as a test case with a comment — the test
file is where future "why does it dedupe like this" questions get answered.

### 7. Steve end-to-end test (enqueue → worker → poll → query)

**What & why** — One test proves the whole job-mode story of doc 04: a crawl enqueued as
ONE steve job, processed by a worker, observable mid-run via the crawler's own tables,
with a small summary (never bodies) as the steve result.

**Evidence / reuse** — Steve's own happy-flow test is the template:
`create → start(1) → find → assert` (steve/tests/jobs.test.ts:46-98; Jobs construction
with `tablePrefix`/`pollTimeoutMs: 100`/`gracefulSigterm: false` at jobs.test.ts:29-38);
`find(uid)` works mid-run; handler return value becomes the stored result
(steve/src/steve/jobs.ts:78-81).

**Spec** — `tests/steve-e2e.test.ts`, gated on `hasPg` like item 4:

1. `createPg()`; build a `Jobs` instance (`tablePrefix: "_test_"`, `pollTimeoutMs: 100`,
   `gracefulSigterm: false`) with the crawl handler from `./steve`'s factory, configured
   with `siteFetch(SMALL_SITE)`, PG stores/persistence on prefix `"_test_"`, silent
   logger. `resetHard()` both steve and crawler schemas.
2. `jobs.create("crawl", { seeds: ["http://site.test/"] })` → assert pending row.
3. `await jobs.start(1)`; poll the `_test___crawler_crawl` row (50 ms interval, 5 s
   timeout) until `status = 'completed'`.
4. Assert: steve job completed with a summary result (has stats/counters, `crawlUid`;
   `JSON.stringify(result).length` sanely small and containing no page body text);
   `_test___crawler_page` rows match the fixture's reachable set; crawl row has final
   stats and `job_uid` back-reference.
5. Teardown: stop worker, `db.end()`.

**Files** — create `/Users/mm/projects/@marianmeres/crawler/tests/steve-e2e.test.ts`.

**Value/Effort/Risk** — med/S/med; it is the only test coupling three schemas + a
polling worker — keep timeouts generous and assertions terminal-state-based to avoid
flakes.

**Implementation notes** — Do not assert intermediate `running` states on a fixed
schedule (the fixture crawl completes in milliseconds); assert the terminal state and
the recorded artifacts. This test also implicitly re-verifies decision 3 (no bodies in
steve JSONB) — make that assertion explicit.

### 8. Release flow: checklist, dry-runs, rp/rpm; mcp.ts backlog

**What & why** — The scaffold already wires the standard release tasks
(`rp`/`rpm` → release + `deno publish` + npm publish, crawler deno.json:10-13);
what's needed is the ordered checklist so the first release is not improvised.

**Evidence / reuse** — Pre-release doc pass:
`/Users/mm/projects/@marianmeres/agents/mm-local-docs/PRE_RELEASE_DOCS_UPDATE.md`
(follow, do not inline). LICENSE and .editorconfig are already fine in the scaffold.
MCP authoring, if ever:
`/Users/mm/projects/@marianmeres/agents/mm-local-docs/MCP_AUTHORING_GUIDE.md`.

**Spec** — release checklist (encode at the bottom of AGENTS.md or as
`docs/RELEASING.md`):

1. Docs pass per PRE_RELEASE_DOCS_UPDATE.md (README/AGENTS.md current with the code).
2. `deno task test` green twice: with `TEST_PG_*` set (full suite incl. PG + steve e2e)
   and without (PG tests auto-ignored).
3. `deno fmt --check` and `deno lint` clean.
4. `deno publish --dry-run` — file list contains src/** + LICENSE/README/AGENTS only
   (item 1's exclude block working).
5. `deno task npm:build` — inspect `.npm-dist/package.json` (6 export keys, deps/peers
   per item 2); optional node smoke:
   `node -e "import('./.npm-dist/dist/mod.js').then(m => console.log(Object.keys(m)))"`.
6. First release: `deno task rp` (0.1.0 → publish JSR + npm). Later: `rpm` for minors.

Backlog (note only, not v1): `mcp.ts` MCP tools per MCP_AUTHORING_GUIDE.md — obvious
candidates are normalize-url / extract-links / parse-robots as pure tools; low priority.

**Files** — create `/Users/mm/projects/@marianmeres/crawler/docs/RELEASING.md` (or an
AGENTS.md section — implementer's call, prefer AGENTS.md to keep file count down).

**Value/Effort/Risk** — med/S/low.

**Implementation notes** — The npm publish step needs an npm account/token with
`--access=public` (already in the scaffold task). Nothing else to configure.

### 9. Recipes/examples dir (6 recipes, doubling as tests)

**What & why** — The recipes are the README's argument for existence (design sketch
§12, tmp/crawler-DESIGN.md:409-421) and the cheapest integration coverage: the pure
report-building parts run against the fixture site in the test suite.

**Evidence / reuse** — Sketch recipe list tmp/crawler-DESIGN.md:411-420 adapted per
owner decisions: incremental re-crawl uses **PG** (decision 9 killed SQLite), SPA crawl
uses an **injected** browser driver (decision 10), scraper shows `onPage` without any
html-to-markdown dependency (decision 5). SIGINT handling belongs in the example, not
the library (tmp/crawler-DESIGN.md:331-332). `examples/**` is JSR-excluded (item 1);
examples import by package name via the self-import map (page-fetcher precedent,
deno.json:37-39).

**Spec** — `examples/` (runnable: `deno run -A --env-file examples/<name>.ts <url>`):
- `broken-links.ts` — assets + checkExternal on; groups `report.graph` by dead `to`
  listing the `from` pages. Pure helper `brokenLinkReport(graph, pages)` exported.
- `sitemap-gen.ts` — internal HTML 200s only, `lastmod` from headers. Pure helper
  `sitemapXml(pages)` exported.
- `incremental-recrawl-pg.ts` — PG stores + page-fetcher conditional-request cache;
  prints changed pages via content_hash comparison (mostly-304 re-crawl).
- `scraper.ts` — `onPage` returning extracted data; comments mark the crawler/scraper
  boundary (bring-your-own parser via the hook).
- `spa-browser.ts` — page-fetcher browser adapter with a consumer-supplied Playwright
  driver; exits with a friendly message when no driver is installed (drivers are never
  dependencies). This is the owner's motivating use case (a site with client-side JS
  "here-and-there", rendered HTML persisted for later consumption), so the example MUST
  show: (a) `createFetcher({ adapters: [http, browser], selectAdapter })` routing —
  HTTP adapter for static pages, browser only where JS rendering is needed (URL-pattern
  or meta-based; `selectAdapter(req)` sees the full FetchRequest incl. `meta`,
  page-fetcher/src/fetcher.ts:50-59, 191-204); (b) a `{selector}` wait strategy on a
  known-JS page (the soft `networkidle` default can proceed early on busy pages,
  flagging `extra.networkidleTimedOut`); (c) that `text()` from the browser adapter IS
  the post-JS serialized DOM (`page.content()` after wait + onPage,
  browser-adapter.ts:487) — which is exactly what `./pg` `persistBody` archives, and
  what `extractLinks` sees, so JS-injected links are discovered and followed.
- `steve-job.ts` — one crawl = one job via the `./steve` factory; raised
  `autoCleanup.maxAllowedRunDurationMinutes`; SIGINT handler registered here; progress
  read from the crawl-run row.
- `tests/recipes.test.ts` — imports `brokenLinkReport` and `sitemapXml` from the two
  examples and asserts their output against a `SMALL_SITE` crawl (fake fetcher, memory
  stores). The PG/browser/steve examples are NOT auto-tested (item 7 covers job mode).

**Files** — create `/Users/mm/projects/@marianmeres/crawler/examples/` with the 6 files
above and `/Users/mm/projects/@marianmeres/crawler/tests/recipes.test.ts`.

**Value/Effort/Risk** — med/M/low; depends on the full API, so it lands last and acts
as the final API-ergonomics review.

**Implementation notes** — Keep each example under ~80 lines and self-explanatory; the
README links them instead of duplicating their code. Examples must not import from
`src/` paths directly — package-name imports only, so they read as consumer code.

## Open questions / decisions needed

- Should the PG-gated tests print a one-line "skipped (no TEST_PG_*)" notice, or ignore
  silently? (Cosmetic; steve/cron offer no precedent since they fail hard. Suggest:
  silent `ignore`, mention the gating in AGENTS.md.)
- `docs/RELEASING.md` vs an AGENTS.md release section (item 8) — implementer's call.
- Whether `@marianmeres/steve` stays in the npm peer list depends on doc 04's final
  type surface (see item 2 note); decide at implementation time.
