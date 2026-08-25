<!--
GENERATED PLAN — @marianmeres/crawler, remaining v1 work (was docs/plan backlog ranks 35-38)
Produced 2026-08-25 by re-cutting docs/plan/PROGRESS.md's open backlog into the current
MULTISTEP_PROGRESS_FILESYSTEM_LAYOUT_INSTRUCTIONS.md + sprint/SPEC.md tracker format.
Claims re-verified against the working tree at commit cebf5d0. No code was changed.
-->

# Packaging, recipes, docs, release

> The JSR half of packaging landed with task 5 — `exports`, `publish.exclude`, the test
> task. The npm half did not: `scripts/build-npm.ts` still passes
> `versionizeDeps([""], denoJson)` and declares **no entry points**, so the npm package
> would export only `"."` and claim zero runtime dependencies while importing
> page-fetcher. Every node consumer would break on install. That is this sprint's first
> task and the only one carrying real risk.
>
> The rest is the package's public face: the six runnable recipes, README + AGENTS.md,
> and the release checklist. It lands last on purpose — the recipes double as the final
> API-ergonomics review, and a README written before `./pg` and `./steve` exist would
> document an API nobody has used.
>
> Full specs: [`../plan/05-testing-docs-release.md`](../plan/05-testing-docs-release.md)
> §2, §9, §5, §8.

## Summary

| # | Task | Value | Effort | Risk |
|---|------|-------|--------|------|
| T35 | `scripts/build-npm.ts` — entry points + real dependency list | high | S | med |
| T36 | Recipes/examples dir (6 recipes) | med | M | low |
| T37 | README + AGENTS.md + `.env.example` | high | M | low |
| T38 | Release checklist + dry runs | med | S | low |

## Tasks

### T35 — `scripts/build-npm.ts`: entry points + real dependency list

**Where it stands** — the whole file is nine lines and every one of the three problems
above is visible in it. `deno.json`'s `exports` map will by then carry six keys
(`.`, `./url`, `./extract`, `./stores`, `./pg`, `./steve`).

**What to build** — [`../plan/05-testing-docs-release.md`](../plan/05-testing-docs-release.md)
§2 verbatim: the flat `src/{name}.ts` re-export shims npmbuild requires
(`src/url.ts`, `src/extract.ts`, `src/stores.ts`, `src/pg.ts`, `src/steve.ts` — each a
one-line `export * from "./{name}/mod.ts"`), `entryPoints`, `dependencies` =
page-fetcher + clog (clog is type-only for us but the emitted `.d.ts` references it, so
a consumer's `tsc` must resolve it), optional `peerDependencies` for `pg`/`@types/pg`/
steve, and `rootFiles` overridden so the default does not ship `docs/` — including this
plan — into the tarball.

**Decided 2026-08-25** — `@marianmeres/steve` stays in the optional peer list **iff** the
built `.npm-dist/dist/steve.d.ts` actually references steve types. Check the emitted file;
if the type surface came out fully local, drop the peer rather than declare a dead one.

**Done when** — `deno task npm:build` succeeds and `.npm-dist/package.json` shows six
export keys, `dependencies` = page-fetcher + clog at real versions,
`peerDependencies`/`peerDependenciesMeta` per the rule above, and no `docs` in the
tarball's file list; plus the node smoke check
`node -e "import('./.npm-dist/dist/mod.js').then(m => console.log(Object.keys(m)))"`
prints the public surface. Record what the steve-peer check decided in the commit message.

**Affected files** — `scripts/build-npm.ts`, `src/url.ts`, `src/extract.ts`,
`src/stores.ts`, `src/pg.ts`, `src/steve.ts`.

**Notes** — the shims also ship to JSR, harmlessly. Keep the "keep in sync with
deno.json exports" comment: shim/exports drift is exactly how this file rots.

### T36 — Recipes / examples dir

**What to build** — [`../plan/05-testing-docs-release.md`](../plan/05-testing-docs-release.md)
§9: `examples/` with `broken-links.ts`, `sitemap-gen.ts`, `incremental-recrawl-pg.ts`,
`scraper.ts`, `spa-browser.ts` and `steve-job.ts`, each runnable as
`deno run -A --env-file examples/<name>.ts <url>` and each under ~80 lines. Examples
import **by package name** through the self-import map, never from `src/` paths — they
have to read as consumer code, because that is the review they are performing.

Two of them export pure helpers (`brokenLinkReport(graph, pages)`, `sitemapXml(pages)`)
so `tests/recipes.test.ts` can assert their output against a `SMALL_SITE` crawl on the
fake fetcher. The PG, browser and steve examples are not auto-tested — T27 and T34 cover
those paths.

`spa-browser.ts` is the owner's motivating use case and must show the three things that
make it work: `selectAdapter` routing between the HTTP and browser adapters, a
`{selector}` wait strategy, and the fact that the browser adapter's `text()` is the
post-JS serialized DOM — which is what gets archived and what `extractLinks` sees.
It exits with a friendly message when no driver is installed; drivers are never
dependencies.

**Done when** — `tests/recipes.test.ts` passes, every example type-checks under
`deno check examples/*.ts`, and each example runs against the fixture or exits with its
documented friendly message rather than a stack trace.

**Affected files** — `examples/*.ts` (6), `tests/recipes.test.ts`, `deno.json` (only if
a self-import entry is missing).

### T37 — README + AGENTS.md + `.env.example`

**What to build** — [`../plan/05-testing-docs-release.md`](../plan/05-testing-docs-release.md)
§5, following
`/Users/mm/projects/@marianmeres/agents/mm-local-docs/HUMAN_DOCUMENTATION_GUIDE.md` for
the README and `AGENT_DOCUMENTATION_GUIDE.md` for AGENTS.md. The `README.md` in the tree
today is a single line.

Beyond the guides' structure, these must appear because each is a documented owner
decision whose absence bites silently:

- the retry-layering rule, verbatim: page-fetcher retries per request, the crawler never
  adds per-page retry, steve retries whole crashed jobs — safe only because PG state
  resumes;
- layered modes: memory default, `./pg` opt-in, never PG-only; npm users of `./pg` or
  `./steve` must install the optional peers;
- **"crawl the content, not the nav"** — `scope.followRegions` and the `beforeExtract` +
  `@marianmeres/html-extract` route given *equal* billing, with the innermost-wins
  footgun and the no-landmarks fallback spelled out;
- the `same-site` heuristic caveat (not the full PSL; injectable);
- robots: `respect: false` warns once; 4xx/failed = allow-all, 5xx = disallow-all;
- the steve guidance box (T33's text, folded in — do not rewrite it);
- browser crawling via an injected driver; `maxTotalBytes` vs page-fetcher's per-request
  `maxBytes`; `persistBody`; the permissive private-host default and how to tighten it;
- **credentials in URLs** (2026-08-25 decision): userinfo is kept verbatim in the
  frontier, the results and the PG rows, and masked in logs — so prefer authenticating
  through fetcher headers, and expect `https://user:pass@host/` to be persisted as given;
- the PG test gating (silent `ignore` without `TEST_PG_*`) — in AGENTS.md.

`.env.example` gets the `TEST_PG_*` block. Never mention private `stack-*` packages.

**Done when** — README and AGENTS.md exist, cover every bullet above, and every code
snippet in them type-checks (extract them into a scratch file and run `deno check`, or
lift them from the examples verified by T36). `.env.example` matches the keys
`tests/_pg.ts` reads.

**Affected files** — `README.md`, `AGENTS.md`, `.env.example`.

### T38 — Release flow: checklist + dry runs

**What to build** — [`../plan/05-testing-docs-release.md`](../plan/05-testing-docs-release.md)
§8: the ordered pre-release checklist, and the dry runs that prove it.

**Decided 2026-08-25** — the checklist lives as a section at the bottom of `AGENTS.md`,
not in a separate `docs/RELEASING.md` (doc 05's own preference; keeps the file count
down and puts it where the agent-facing invariants already are).

Checklist content: the docs pass per `PRE_RELEASE_DOCS_UPDATE.md`; `deno task test`
green **twice** — once with `TEST_PG_*` set and once without; `deno fmt --check` and
`deno lint` clean; `deno publish --dry-run` file list containing `src/**` plus
LICENSE/README/AGENTS only; `deno task npm:build` plus the `.npm-dist/package.json`
inspection from T35; then `deno task rp` for the first release.

Also record the deliberately-not-v1 note: `mcp.ts` MCP tools (normalize-url,
extract-links, parse-robots as pure tools) per `MCP_AUTHORING_GUIDE.md`, low priority.

**Done when** — the checklist section exists in AGENTS.md; `deno publish --dry-run` and
`deno task npm:build` have both been run and their output is summarized in the commit
message (paths shipped, package.json keys); `deno fmt --check` and `deno lint` are clean
across `src/`, `tests/`, `examples/` and `scripts/`.

**Affected files** — `AGENTS.md`.

**Not this task, and not the machine's** — the actual `deno task rp` (JSR + npm publish)
is irreversible and outward-facing. It is a human step, deliberately kept out of the
tracker table; see the note under the sprint table in `PROGRESS.md`.
