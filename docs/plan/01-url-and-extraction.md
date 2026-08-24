<!--
GENERATED ANALYSIS — @marianmeres/crawler implementation plan
Produced 2026-08-24 by multi-agent research -> adversarial verify -> synthesize.
Claims verified against ecosystem package working trees (page-fetcher v0.4.0, steve v3.0.0,
cron v3.2.0, clog v3.21.0). The crawler repo itself is a pre-first-commit scaffold.
Planning artifact; no code was changed.
-->

# URL Normalization & Extraction (./url, ./extract)

> These two submodules are the pure, zero-dependency foundation of the crawler: `./url`
> defines what "the same page" means (normalization *is* deduplication — get it wrong and
> the crawl loops forever or misses half the site, design sketch
> `tmp/crawler-DESIGN.md:190-193`), and `./extract` turns fetched bytes into candidate
> links and robots directives. Both must be usable entirely standalone
> (`tmp/crawler-DESIGN.md:56-57`) and are the sketch's implementation-order items 1 and 2
> (`tmp/crawler-DESIGN.md:442-444`).
>
> The single most important takeaway: **nothing in the ecosystem is reusable here.** The
> full package index (`mm-local-docs/ecosystem.md:14-60`) has no HTML parsing, link
> extraction, robots.txt, sitemap, or URL-normalization package, and page-fetcher is
> explicitly transport-only (`ecosystem.md:68`). This is greenfield code, written without
> a DOM or XML dependency (`tmp/crawler-DESIGN.md:43-45`). The retired nettle-crawler has
> prior art to consult (`@nettle/nettle-crawler/src/crawler/utils/`), but it is
> cheerio-based, lossy, and too naive to copy — redesign, don't port.
>
> Headline recommendation: lean on the WHATWG `URL` parser for everything it already
> guarantees (lowercasing, IDNA/punycode, default-port stripping, dot-segment resolution)
> and hand-write only the four things it does not do: percent-encoding canonicalization,
> query policy, trailing-slash policy, and the tracking-param blocklist. That keeps
> `normalizeUrl` small and makes the required idempotency property almost free to prove.
>
> Note: the summary table below is sorted by (value, effort) per plan convention. The
> *build* order is different and binding: normalizeUrl first (item 3), then extractLinks
> (item 6) — everything downstream inherits their semantics (`tmp/crawler-DESIGN.md:442-444`).

## Summary of work items

| # | Work item                                                    | Value | Effort | Risk |
|---|--------------------------------------------------------------|-------|--------|------|
| 1 | isSameSite + registrable-domain heuristic + classifyLink     | high  | S      | med  |
| 2 | parseMetaRobots + parseXRobotsTag                            | high  | S      | low  |
| 3 | normalizeUrl pipeline + NormalizeOptions                     | high  | M      | med  |
| 4 | parseRobotsTxt + wildcard matcher                            | high  | M      | med  |
| 5 | Unit-test corpora: property tests + fixtures                 | high  | M      | low  |
| 6 | extractLinks tolerant HTML tokenizer                         | high  | L      | med  |
| 7 | parseSitemap (urlset, sitemapindex, plain-text)              | med   | S      | low  |

Shared constraints for every item:

- **Zero runtime imports.** `src/url/` and `src/extract/` import nothing — not even
  `@std/*` (test files may use `@std/assert`). This is what makes them standalone.
- **No logger.** Owner decision 7 threads `logger?: Logger` through factories and
  constructors; these are pure functions with no side channel. They signal failure by
  return value (`null` / `undefined` / skip), never by logging or throwing.
- **Never throw on bad input.** Malformed URLs return `null`; malformed HTML/XML/robots
  input degrades to "fewer results", per `tmp/crawler-DESIGN.md:263`.
- **deno.json exports.** `exports` is a single string today (`deno.json:4`). The
  string→map conversion is doc 05's packaging item (05 §1 specs the full map, `"./url"`
  and `"./extract"` entries included); nothing in this doc edits `deno.json`.
  Coordinate, don't race.

> **Cut from the draft:** the exports-map work was misattributed to doc 02 — doc 05 §1
> owns every `deno.json` change (doc 02 says so itself at its line 233).

## Work items (detailed)

### 1. isSameSite + registrable-domain heuristic + classifyLink

**What & why**
`isSameSite` powers the `subdomains: "same-site"` scope mode; `classifyLink` labels every
link edge `internal | external` (the `LinkRecord.kind` of `tmp/crawler-DESIGN.md:168`).
True same-site comparison needs the Public Suffix List so `co.uk` / `gov.sk` are not
treated as registrable domains (`tmp/crawler-DESIGN.md:228-231`). Owner decision 12
closed the approach: a small built-in multi-label-TLD heuristic plus an injectable PSL
override, with the caveat documented; the default scope stays `"same-host"` so the
heuristic only affects opt-in `"same-site"`.

**Evidence / reuse**
- Sketch signature: `tmp/crawler-DESIGN.md:224-226`; PSL discussion `:228-231`;
  default scope `"same-host"`: `tmp/crawler-DESIGN.md:272`.
- Prior art: nettle-crawler classifies internal/external by exact hostname membership in
  a caller-supplied list (`nettle-crawler/src/crawler/utils/extract-links.ts:45-56`) —
  no subdomain or registrable-domain notion at all. Consult for the API gap it left,
  do not copy.
- Ecosystem gap: no PSL/domain package exists (`ecosystem.md:14-60`).

**Spec**

```ts
export type SubdomainsMode = "same-host" | "same-site" | "any";

export interface SameSiteOptions {
	/** Default "same-host". */
	subdomains?: SubdomainsMode;
	/**
	 * PSL override: (lowercase ASCII host) => registrable domain, or null when the
	 * host is itself a public suffix / unregistrable. Default: built-in heuristic.
	 */
	getRegistrableDomain?: (host: string) => string | null;
}

/** True when a and b are the "same site" under the given mode. Unparsable input => false. */
export function isSameSite(a: string | URL, b: string | URL, opts?: SameSiteOptions): boolean;

/** Built-in heuristic (the default for isSameSite). Exported for reuse and testing. */
export function getRegistrableDomain(host: string): string | null;

/** "internal" iff isSameSite(from, to, opts); unparsable `to` => "external". */
export function classifyLink(
	from: string | URL,
	to: string | URL,
	opts?: SameSiteOptions,
): "internal" | "external";
```

Heuristic rules for `getRegistrableDomain(host)` (host is already lowercase ASCII —
callers pass `new URL(x).hostname`):

1. IPv4 literal or bracketed IPv6 (`[…]` — `URL.hostname` keeps the brackets) → return
   `host` unchanged (same-site === same-host).
2. Single label (`localhost`, intranet names) → return `host`.
3. Split on `.`; a two-label suffix is "public" when the last label is 2 chars (ccTLD)
   AND the second-to-last label is in
   `SECOND_LEVEL_LABELS = new Set(["co","com","net","org","gov","edu","ac","mil","sch","ne","or","go"])`.
   Covers `co.uk`, `com.au`, `gov.sk`, `co.jp`, `or.at`, … without a data file.
4. Public two-label suffix → registrable = last **3** labels; otherwise last **2**.
5. If the host *is* exactly a public suffix (e.g. `co.uk` itself) → `null`.

Modes: `"any"` → both parse ⇒ true. `"same-host"` → exact `hostname` equality (URL
parsing already lowercased + IDNA-normalized both). `"same-site"` → both registrable
domains non-null and equal.

Documented caveat (README + JSDoc, per decision 12): the heuristic knows nothing about
non-ccTLD public suffixes (`github.io`, `web.app`, …) — those compare as same-site. For
correctness at that level, inject `getRegistrableDomain` backed by a real PSL library.

**Files**
- `src/url/same-site.ts` (all three functions + `SECOND_LEVEL_LABELS`)
- `src/url/mod.ts` (re-export)
- `tests/url/is-same-site.test.ts`, `tests/url/classify-link.test.ts`

**Value/Effort/Risk** — high / S / med: the heuristic will mislabel PSL-only suffixes;
mitigated by documented caveat + injection point + same-host default.

**Implementation notes**
- Accept `string | URL`; for strings, parse with `new URL()` in try/catch — any failure
  ⇒ `false` / `"external"`, never a throw.
- Compare hosts case-insensitively by construction (WHATWG URL lowercases hostname).
- `classifyLink` is a two-liner over `isSameSite`; keep it here (not in the crawl loop)
  so `./url` stays the single authority on link locality.

### 2. parseMetaRobots + parseXRobotsTag

**What & why**
`<meta name="robots">` and the `X-Robots-Tag` response header must be honoured for
*following* decisions (`tmp/crawler-DESIGN.md:311-312`): `nofollow` stops link
expansion from a page, `noindex` is recorded for consumers. Small, pure, and required
by the `respectRobots: true` default (backbone decision 14).

**Evidence / reuse**
- Sketch: `tmp/crawler-DESIGN.md:311-312`. No prior art in nettle-crawler (it never
  handled robots at all — nothing under `nettle-crawler/src/crawler/utils/` touches it).
- The header value reaches us via page-fetcher's `FetchResult.headers`
  (`page-fetcher/src/types.ts:166-167` — `headers: Headers` of the final response);
  `Headers.get()` joins repeated headers with `", "`, so the parser must handle
  comma-joined multi-instance values.

**Spec**

```ts
export interface RobotsDirectives {
	noindex: boolean;
	nofollow: boolean;
	/** Every directive token that applied (lowercased, deduped), for diagnostics. */
	raw: string[];
}

/**
 * Scan html for <meta name=... content=...> robots directives.
 * `names` = which meta names address us; default ["robots"]. The crawl loop adds its
 * own UA token (e.g. "marianmeres-crawler") so bot-specific tags work. Case-insensitive.
 * Multiple matching tags merge most-restrictive ("none" => noindex + nofollow).
 */
export function parseMetaRobots(html: string, opts?: { names?: string[] }): RobotsDirectives;

/**
 * Parse an X-Robots-Tag header value (possibly comma-joined from repeated headers).
 * Unscoped directives always apply; "botname: directive" scoped groups apply only when
 * `botName` matches (case-insensitive). Colon-bearing directives that are NOT scopes
 * (unavailable_after, max-snippet, max-image-preview, max-video-preview) are recognized
 * and kept in `raw` but do not start a scope.
 */
export function parseXRobotsTag(
	header: string | null | undefined,
	opts?: { botName?: string },
): RobotsDirectives;
```

Directive vocabulary handled: `noindex`, `nofollow`, `none` (= both), `all` (= neither);
everything else lands in `raw` untouched. Missing/empty input → all-false, empty `raw`.

**Files**
- `src/extract/meta-robots.ts`
- `src/extract/mod.ts` (re-export)
- `tests/extract/meta-robots.test.ts`

**Value/Effort/Risk** — high / S / low: tiny surface; the only subtlety is the
comma-joined scoped-group header format, covered by fixtures in item 5.

**Implementation notes**
- `parseMetaRobots` reuses the item-6 tag scanner (`_html.ts`) to find `<meta>` tags —
  do NOT write a second ad-hoc regex; scanning inside `<script>`/comments must be
  avoided identically in both.
- Merge rule when the crawl loop combines meta + header: most restrictive wins; that
  combination lives in the crawl loop (doc 04), not here.

### 3. normalizeUrl pipeline + NormalizeOptions

**What & why**
The single most correctness-critical function in the package: it defines URL identity
for the frontier, visited set, and the PG `__crawler_url` unique key. The full pipeline
is design sketch §5 (`tmp/crawler-DESIGN.md:190-221`), every step individually
toggleable, with `normalize(normalize(x)) === normalize(x)` as a REQUIRED test
(`tmp/crawler-DESIGN.md:208-210`).

**Evidence / reuse**
- Sketch signature and pipeline: `tmp/crawler-DESIGN.md:196`, steps 1-11 at `:199-220`.
- Base resolution rule: resolve against the page's `<base href>` if present, otherwise
  `finalUrl` — not the requested URL (`tmp/crawler-DESIGN.md:201-202`); page-fetcher
  states the same contract on `FetchResult.finalUrl`: "Resolve relative references
  against this" (`page-fetcher/src/types.ts:160-161`).
- Prior art (consult, then discard): `nettle-crawler/src/crawler/utils/normalize-url.ts`
  — force-prefixes `https://` on schemeless input (`normalize-url.ts:62-65`, wrong for a
  crawler: link extraction must not invent schemes), returns the ORIGINAL url on parse
  failure with a `console.warn` (`normalize-url.ts:127-130`, poisons dedup keys —
  we return `null` instead), strips only `utm_*` (`normalize-url.ts:104`), and has no
  base resolution, scheme rejection, encoding canon, or length cap.
  `resolve-url.ts:26-37` shows the absolute-then-relative resolve fallback shape.

**Spec**

```ts
/** Canonical form, or null = "not a fetchable URL" (bad parse, scheme, or too long). */
export function normalizeUrl(
	input: string,
	base?: string,
	opts?: NormalizeOptions,
): string | null;

export interface NormalizeOptions {
	/** Scheme allow-list. Default ["http:", "https:"]; anything else => null. */
	allowSchemes?: string[];
	/** Strip `#fragment`. Default true. */
	stripFragment?: boolean;
	/** When stripping fragments, keep `#!…` hashbang routes. Default false. */
	keepHashbang?: boolean;
	/** Canonicalize percent-encoding (see algorithm below). Default true. */
	normalizeEncoding?: boolean;
	/** Collapse `//` runs in the path (`/a//b` => `/a/b`). Default true. */
	collapseSlashes?: boolean;
	/** Trailing-slash policy; the root "/" is never touched. Default "strip". */
	trailingSlash?: "strip" | "keep";
	/** Rebuild the query via URLSearchParams (enables the three options below). Default true. */
	normalizeQuery?: boolean;
	/** Params to drop. string = case-insensitive exact name. Default DEFAULT_STRIP_PARAMS. */
	stripParams?: (string | RegExp)[];
	/** Sort remaining params (URLSearchParams.sort — stable, by key). Default true. */
	sortParams?: boolean;
	/** Drop params with empty values. Default false. */
	stripEmptyParams?: boolean;
	/** Strip one leading `www.` label (only if >= 2 labels remain). Default false. */
	stripWww?: boolean;
	/** Reject (=> null) when the final string exceeds this. Default 2048. */
	maxLength?: number;
}

export const DEFAULT_STRIP_PARAMS: (string | RegExp)[] = [
	/^utm_/i, "fbclid", "gclid", "dclid", "gbraid", "wbraid", "msclkid",
	"mc_cid", "mc_eid", "_ga", "_gl", "ref", "igshid", "spm",
	/^(phpsessid|jsessionid|sessionid|session_id|sid)$/i,
];
```

Pipeline (fixed order; a disabled step is skipped, the rest still run):

1. Trim `input`; empty → `null`. Parse: `new URL(input, base)` (base optional);
   `TypeError` → `null`. No scheme guessing — schemeless relative refs resolve via
   `base`, schemeless absolute input without a base is `null`. (Seed-level leniency
   like `crawl("example.com")` is doc 02's concern, not this function's.)
2. Scheme gate: `url.protocol` not in `allowSchemes` → `null`. The default allow-list
   rejects the sketch's whole list (`mailto:`, `tel:`, `javascript:`, `data:`, `blob:`,
   `sms:`, `ftp:`, `about:`, `tmp/crawler-DESIGN.md:203-204`) *and* anything unknown —
   an allow-list is the safe inversion of the sketch's reject-list; widen it to opt in.
3. Inherent WHATWG steps — always on, deliberately NOT options (document this in
   JSDoc): scheme+host lowercasing, IDNA/punycode to ASCII (`münchen.de` →
   `xn--mnchen-3ya.de`), default-port stripping (`:80`/`:443`), and `.`/`..` dot-segment
   resolution all happen inside `new URL()` and cannot be disabled.
4. Fragment: if `stripFragment` and not (`keepHashbang` and `url.hash.startsWith("#!")`)
   → drop hash.
5. `stripWww`: hostname starts with `www.` and has ≥ 3 labels → remove the first label.
6. Percent-encoding canon (when `normalizeEncoding`), applied to `pathname` (and to the
   raw `search`/`hash` only when `normalizeQuery` is off / hash kept). Single pass:
   - `%XX` with valid hex whose byte is unreserved (`A-Z a-z 0-9 - . _ ~`) → decode to
     the literal char;
   - other valid `%XX` → uppercase the hex;
   - `%` not followed by two hex digits → emit `%25`;
   - all other chars pass through untouched (the WHATWG parser already applied its
     per-component encode set at parse time; re-parsing our output re-applies the same
     set, which is the idempotency argument — see notes).
7. `collapseSlashes`: `pathname.replace(/\/{2,}/g, "/")` (a literal `%2F` is a triplet,
   never touched).
8. `trailingSlash: "strip"`: `pathname !== "/"` and ends with `/` → drop the last char.
9. Query (when `normalizeQuery`): parse `url.search` with `URLSearchParams`; drop keys
   matching `stripParams` (strings compare case-insensitively, RegExp as given); drop
   empty-valued entries when `stripEmptyParams`; `params.sort()` when `sortParams`
   (spec-stable: same-key value order preserved); serialize. Empty result → no `?`.
   Note: `URLSearchParams` serializes spaces as `+` — that IS the canonical query form
   here, and it round-trips (parse `+` → space → serialize `+`), so idempotency holds.
10. Reassemble manually — never assign back through the `URL` setters, which would
    re-encode: `protocol + "//" + userinfo + host + pathname + search + hash`
    (`userinfo` = `username[":"+password]"@"` when present, kept verbatim — see open
    question 1).
11. Length: final string length > `maxLength` → `null`.

Required tests (item 5 carries the corpus): idempotency property for every non-null
result; the WHATWG-inherent steps (case, IDN, ports, dot segments); every option toggled
on/off; `null` for each rejected scheme and for over-length URLs.

**Files**
- `src/url/normalize-url.ts` (pipeline + `DEFAULT_STRIP_PARAMS` + internal
  `canonPercentEncoding()` helper)
- `src/url/mod.ts` (re-export; created here — this is the first `./url` item to land)
- (no `deno.json` change — the `"./url"` map entry ships with doc 05 §1)
- `tests/url/normalize-url.test.ts`

**Value/Effort/Risk** — high / M / med: the encoding-canon + reassembly interaction is
the one genuinely subtle part; the idempotency property test is the safety net.

**Implementation notes**
- Return type is plain `string | null` — no branded `NormalizedUrl` type here; if doc 02
  wants a branded alias for hook signatures it aliases on its side.
- Idempotency proof sketch (encode this reasoning as a comment): every transform emits
  only (a) unreserved literals — which the WHATWG parser never re-encodes, (b) uppercase
  `%XX` triplets — preserved verbatim by the parser, (c) `URLSearchParams` output —
  fixed point under parse/serialize. So `new URL(out)` reproduces the same components
  and the pipeline finds nothing left to change.
- Multi-byte sequences (`%C3%A9`) stay encoded (only single-byte unreserved decodes) —
  correct and idempotent by construction.
- Do not decode reserved-purpose triplets: `%2F` in a path, `%26`/`%3D` in a query etc.
  survive automatically because only unreserved bytes are decoded (RFC 3986 §6.2.2
  semantics).
- Keep the function total and allocation-light: one `URL` parse, one pass per component,
  one join. It sits on the hot path of every extracted link (potentially 10^2 per page).

### 4. parseRobotsTxt + wildcard matcher

**What & why**
Parse robots.txt into an inspectable structure with a fast `isAllowed()` matcher:
user-agent group selection, `Allow`/`Disallow` longest-match precedence with `*`/`$`
wildcards, `Crawl-delay`, and `Sitemap:` lines (`tmp/crawler-DESIGN.md:308-310`).
Fetching, caching, and the 4xx-allow / 5xx-disallow policy are the crawl loop's job
(backbone decision 14, doc 04) — this item is the pure parser + matcher only, but it
ships the `robotsAllowAll()` / `robotsDisallowAll()` values that policy needs.

**Evidence / reuse**
- Sketch: `tmp/crawler-DESIGN.md:305-315`. Ecosystem: nothing exists
  (`ecosystem.md:14-60`); nettle-crawler never implemented robots.
- The crawl loop fetches robots via page-fetcher with a small `maxBytes` and text
  allow-list (decision 14), so the parser can assume bounded text input.

**Spec**

```ts
export interface RobotsRule {
	allow: boolean;
	/** Pattern as written (after trim), e.g. "/private*", "/*.pdf$". */
	pattern: string;
}

export interface RobotsGroup {
	/** Lowercased user-agent tokens this group addresses ("*" possible). */
	userAgents: string[];
	rules: RobotsRule[];
	/** Seconds (parsed as float); undefined when absent/unparsable. */
	crawlDelay?: number;
}

export interface RobotsTxt {
	groups: RobotsGroup[];
	/** Sitemap: values as written (absolute per spec; kept verbatim, caller resolves). */
	sitemaps: string[];
	/**
	 * pathAndQuery = url.pathname + url.search. Longest-pattern match wins; on equal
	 * length Allow wins. No matching rule => allowed. Group selection: the group whose
	 * longest UA token is a case-insensitive substring of `userAgent`, else the "*"
	 * group, else allowed.
	 */
	isAllowed(pathAndQuery: string, userAgent: string): boolean;
	crawlDelay(userAgent: string): number | undefined;
}

export function parseRobotsTxt(text: string): RobotsTxt;
/** Everything allowed — the 4xx / fetch-failure policy value (decision 14). */
export function robotsAllowAll(): RobotsTxt;
/** Everything disallowed — the 5xx policy value (decision 14). */
export function robotsDisallowAll(): RobotsTxt;
```

Parsing rules:
- Strip BOM; split on `\r?\n`; strip `#` comments; `directive: value` split on the FIRST
  colon; directive names case-insensitive; unknown directives ignored.
- Consecutive `User-agent:` lines open ONE group (RFC 9309 grouping); a rule line before
  any `User-agent` opens an implicit `*` group; groups with identical UA sets are NOT
  merged structurally (keep parse fidelity) but the matcher unions their rules.
- `Disallow:` with empty value contributes nothing (= allow all).
- `Sitemap:` is global regardless of position.
- Soft caps against hostile input: ignore lines beyond 10 000 and patterns longer than
  2 000 chars (input size itself is bounded upstream by page-fetcher `maxBytes`).

Matcher compilation (per rule, lazy + memoized on first `isAllowed` call): escape regex
metachars except `*` and a trailing `$`; `*` → `[\s\S]*`; trailing `$` → `$`; anchor
with `^`. Precedence: longest `pattern` string wins; tie → allow. Match target is the
percent-encoded `pathname + search` as-is (no decoding pass; note the RFC 9309 octet
comparison caveat in JSDoc). Group selection memoized per `userAgent` string.

**Files**
- `src/extract/robots-txt.ts`
- `src/extract/mod.ts` (re-export)
- `tests/extract/robots-txt.test.ts`

**Value/Effort/Risk** — high / M / med: precedence + group-selection edge cases are
where real crawlers disagree; the fixture set in item 5 pins our documented behavior.

**Implementation notes**
- `robotsAllowAll()` = `parseRobotsTxt("")` semantics; `robotsDisallowAll()` = a
  synthetic `*` group with `{allow: false, pattern: "/"}`. Both return fresh objects
  (they carry memo state).
- Keep the matcher on `RobotsTxt` (closure over compiled rules) rather than a free
  function — the crawl loop caches one `RobotsTxt` per origin and calls `isAllowed`
  per URL; compile-once matters.
- `Crawl-delay` consumption (`max(perHostDelay, crawlDelay)`) is the scheduler's job
  (`tmp/crawler-DESIGN.md:323`, doc 04); here it is only parsed and exposed.

### 5. Unit-test corpora: property tests + fixtures

**What & why**
The sketch demands normalizeUrl be "heavily unit-tested" with idempotency as a REQUIRED
property (`tmp/crawler-DESIGN.md:192-196, 208-210`) and extractLinks proven "against
real-world messy fixtures" (`tmp/crawler-DESIGN.md:444`). This item builds the shared
corpus infrastructure the other six items plug into, so fixtures are named once and
reused, not scattered.

**Evidence / reuse**
- `deno.json:6` — `"test": "deno test"` today grants no permissions at all, so fixture
  reads would fail; doc 05 §1 owns the task and specs `deno test -A --env-file`
  (steve/cron precedent, backbone decision 8), which covers them.
- No property-testing dep exists in the ecosystem and none is added: a ~30-line seeded
  PRNG generator suffices.

**Spec**

Directory layout (create exactly this):

```
tests/
  url/
    normalize-url.test.ts            table-driven over fixtures/urls/normalize-cases.json
    normalize-url-property.test.ts   seeded fuzz: idempotency + reparse stability
    is-same-site.test.ts
    classify-link.test.ts
  extract/
    extract-links.test.ts            fixture-driven + inline cases
    extract-links-fuzz.test.ts       never-throws on random/truncated bytes
    robots-txt.test.ts
    meta-robots.test.ts
    sitemap.test.ts
  fixtures/
    urls/normalize-cases.json
    html/  basic.html  messy-unclosed.html  base-href.html  entities.html
           srcset.html  meta-refresh.html  script-noise.html  assets.html
           anchor-text.html  giant.html
    robots/  basic.txt  wildcards.txt  groups.txt  crawl-delay.txt
             empty.txt  bom-crlf.txt  conflicting-precedence.txt  hostile.txt
    sitemaps/  urlset.xml  sitemapindex.xml  broken.xml  cdata-entities.xml  plain.txt
```

`normalize-cases.json` format (table-driven; `expected: null` = rejection):

```json
{ "cases": [
	{ "name": "strips utm + sorts", "input": "https://Ex.com/a?utm_source=x&b=2&a=1",
	  "base": null, "opts": {}, "expected": "https://ex.com/a?a=1&b=2" }
] }
```

Property test (`normalize-url-property.test.ts`): seeded xorshift PRNG (fixed seed in
the file → reproducible); generators compose random scheme × host (incl. IDN labels,
ports, `www.`) × path (dot segments, `//` runs, `%`-junk incl. truncated `%G`, unicode)
× query (dup keys, empty values, tracking params, `+`/`%20` mixes) × fragment (incl.
`#!`); ≥ 1000 iterations × a few option profiles (defaults, all-off, all-on). Assert
for every non-null result `r`: `normalizeUrl(r, undefined, sameOpts) === r`, and
`new URL(r)` does not throw.

Fixture intent worth pinning (per file):
- `script-noise.html` — `<a href>` strings inside `<script>`, `<style>`, and comments
  must NOT be extracted (the tokenizer-skip proof).
- `messy-unclosed.html` — unclosed tags, attribute soup, stray `<`, `>` inside quoted
  attrs, duplicate attrs (first wins).
- `base-href.html` — `<base href>` present; only the FIRST `<base>` counts.
- `entities.html` — `&amp;` in hrefs, numeric/hex entities in anchor text.
- `giant.html` — thousands of links; asserts the `maxLinks` cap and linear-ish runtime.
- `robots/hostile.txt` — 100k lines / huge patterns; asserts the soft caps of item 4.
- `robots/conflicting-precedence.txt` — equal-length Allow vs Disallow (allow wins),
  longest-match cases with `*` and `$`.

**Files** — as listed above; no `src/` changes.

**Value/Effort/Risk** — high / M / low: mechanical once the layout is fixed; the value
is that items 3/4/6 are unshippable without it (idempotency is a stated requirement).

**Implementation notes**
- Keep fixture files small and synthetic-but-nasty rather than vendoring real pages
  (license noise, churn); `giant.html` is generated by the test at setup if > 100 KB is
  needed rather than committed.
- Fixture reads (`Deno.readTextFile` relative to `import.meta.dirname`) need
  `--allow-read`; doc 05's `deno test -A --env-file` task grants it. Nothing in these
  suites needs env, net, or write access — they also pass under a narrow
  `deno test --allow-read=tests`, handy for running the pure modules standalone.

> **Cut from the draft:** the proposal to change the `test` task to
> `deno test --allow-read=tests` — doc 05 §1 owns `deno.json` tasks and specs a single
> `deno test -A --env-file` for the whole suite.

### 6. extractLinks tolerant HTML tokenizer

**What & why**
Turn an HTML string into `RawLink[]` covering every source in the sketch's table with
its exact defaults (`tmp/crawler-DESIGN.md:243-254`), plus anchor text and
`rel=nofollow/ugc/sponsored` capture (`:256-258`), never throwing on broken markup
(`:263`), and without a DOM dependency (`:43-45`). This is the largest single piece
of greenfield code in the two submodules.

**Evidence / reuse**
- Prior art to consult-not-copy: `nettle-crawler/src/crawler/utils/extract-links.ts`
  is cheerio-based (`extract-links.ts:1,41` — exactly the hard dependency the sketch
  forbids), extracts only `a[href]` (`:48`), silently swallows resolution errors
  (`:58-60`), and returns deduped string arrays losing anchor text/rel/order (`:63-66`).
  `pick-html-base.ts:4-14` shows the `<base href>`-overrides-baseUrl behavior we keep
  (first `<base>` wins, resolved against the caller base, fall back on failure).
- The caller passes `finalUrl` as `baseUrl` (`page-fetcher/src/types.ts:160-161`).

**Spec**

```ts
export interface RawLink {
	/** href/src/content-url exactly as written, entity-decoded and trimmed. */
	href: string;
	/** Absolute URL resolved against the effective base; undefined when unresolvable. */
	url?: string;
	/** Source element: "a"|"area"|"link"|"iframe"|"frame"|"meta"|"img"|"script"|"source"|"video"|"audio". */
	tag: string;
	/** Link class per the sketch table; feeds LinkRecord.rel. */
	rel: "page" | "asset" | "canonical" | "alternate" | "next" | "prev" | "iframe";
	nofollow: boolean;
	ugc: boolean;
	sponsored: boolean;
	/** <a>/<area> only: trimmed, whitespace-collapsed, entity-decoded, length-capped. */
	anchorText?: string;
	/** link[rel=alternate] only. */
	hreflang?: string;
}

export interface ExtractOptions {
	anchors?: boolean;      // default true  — <a href>, <area href>          rel "page"
	canonical?: boolean;    // default true  — <link rel=canonical>           rel "canonical"
	nextPrev?: boolean;     // default true  — <link rel=next|prev>           rel "next"/"prev"
	metaRefresh?: boolean;  // default true  — <meta http-equiv=refresh>      rel "page"
	alternate?: boolean;    // default false — <link rel=alternate hreflang>  rel "alternate"
	iframes?: boolean;      // default false — <iframe src>, <frame src>      rel "iframe"
	assets?: boolean;       // default false — img/script/source/video/audio src + poster,
	                        //                 <link rel=stylesheet>          rel "asset"
	srcset?: boolean;       // default false — srcset candidates (img/source) rel "asset"
	maxAnchorText?: number; // default 200 chars
	maxLinks?: number;      // default 10_000 — hard stop, tail silently dropped
}

/** Never throws. Order of appearance preserved. Occurrences are NOT deduped. */
export function extractLinks(html: string, baseUrl: string, opts?: ExtractOptions): RawLink[];

/** Effective base: first <base href> resolved against baseUrl, else baseUrl. */
export function extractBaseHref(html: string, baseUrl: string): string;

/** First <title> text: decoded, collapsed, trimmed, capped (default 512). Never throws.
 * Feeds PageResult.title (doc 02); uses the same _html.ts scanner (skips comments,
 * ignores <title> inside <svg>). */
export function extractTitle(html: string, opts?: { maxLength?: number }): string | undefined;
```

Defaults mirror the sketch table exactly (`tmp/crawler-DESIGN.md:243-254`); the table's
`sitemap` row is NOT an extractLinks source — sitemaps are item 7 + robots `Sitemap:`
lines, wired by the crawl loop. Assets stay off by default; the broken-link recipe
turns them on (`tmp/crawler-DESIGN.md:260-261`).

Tokenizer (single forward scan, no DOM, no global regex over the whole document):

1. At each `<`: `<!--` → skip to `-->`; `<script`/`<style` (name boundary) → process the
   opening tag (a `script src` is an asset candidate), then skip to the matching
   case-insensitive `</script`/`</style`; `<![CDATA[` → skip to `]]>`; `<!`/`<?` → skip
   to `>`; `</` → closing tag (tracked only while capturing anchor text); otherwise read
   the tag name and, for tags of interest, scan to the closing `>` respecting quoted
   attribute values (a `>` inside quotes must not end the tag).
2. Attributes: tolerant regex over the tag body —
   `([^\s"'>/=]+)\s*(?:=\s*("[^"]*"|'[^']*'|[^\s>]+))?` — names lowercased, first
   occurrence wins, unquoted/single/double all accepted.
3. Entities: minimal decoder for `&amp; &lt; &gt; &quot; &apos; &nbsp;` + `&#\d+;` +
   `&#x[0-9a-f]+;`, applied to attribute values and anchor text (hrefs routinely
   contain `&amp;`).
4. Effective base: first `<base href>` wins; resolved against `baseUrl`; on failure keep
   `baseUrl` (pick-html-base behavior). Links before the `<base>` tag also use it —
   collect first or two-phase scan (see notes).
5. Resolution: `new URL(href, effectiveBase)` in try/catch → `url` or `undefined`.
   Scheme filtering is NOT done here — `normalizeUrl` owns rejection; the crawl loop
   needs the raw link to record `skipReason: "bad-scheme"` (`tmp/crawler-DESIGN.md:286-287`).
6. Anchor text: capture between the `<a>` open tag and its `</a>` within a bounded
   window (4096 source chars), stripping nested tags, then decode/collapse/trim/cap.
7. Meta refresh: `http-equiv="refresh"` (case-insensitive) → parse
   `content="5; url=/next"` tolerantly (`;` or `,`, optional `url=`, optional quotes);
   no url part → no link.
8. `srcset`: split candidates on `,`, take the first whitespace-delimited token of each.
   Caveat (JSDoc): descriptor-less URLs containing commas can mis-split — accepted
   tolerance, matches what lenient consumers do.
9. `rel` attribute on a/area/link: whitespace-split, lowercased set → `nofollow`, `ugc`,
   `sponsored` flags; `<link>` classification: `canonical`/`next`/`prev`/`alternate`
   (with `hreflang`)/`stylesheet` (asset).

**Files**
- `src/extract/extract-links.ts` (extractLinks, extractBaseHref)
- `src/extract/_html.ts` (internal: tag scanner, attr parser, entity decoder — shared
  with item 2's parseMetaRobots)
- `src/extract/mod.ts` (created here — first `./extract` item; re-exports items 2/4/7 as
  they land)
- (no `deno.json` change — the `"./extract"` map entry ships with doc 05 §1)
- `tests/extract/extract-links.test.ts`, `tests/extract/extract-links-fuzz.test.ts`

**Value/Effort/Risk** — high / L / med: hand-rolled HTML tolerance is the risk; bounded
by the never-throws fuzz test, the skip-regions design, and `maxLinks`/window caps.

**Implementation notes**
- Two-phase for `<base>`: cheapest correct approach is scan once collecting candidate
  links with raw hrefs, resolve at the end against the effective base found during the
  same pass (base-before-use is not required by browsers either — first `<base>` in the
  document governs all links). This keeps it single-pass over the input.
- Avoid catastrophic backtracking: no regex ever runs over the whole document — only
  over single tag bodies (bounded by the tag scan) — and all skips use `indexOf`.
- Emit order = document order; do not dedupe (the crawl-loop/PG layer decides edge
  dedup policy for `__crawler_link`, doc 03/04's concern).
- `video poster` and `source src`+`srcset` count as assets; keep the tag list closed —
  new sources are an options change, not a heuristic.
- Performance target: linear in input size, one pass, no full-document copies (the
  `retainBody` bytes are already capped upstream by page-fetcher `maxBytes`).

### 7. parseSitemap (urlset, sitemapindex, plain-text)

**What & why**
Parse sitemap documents so robots `Sitemap:` lines can seed the frontier (opt-in,
`tmp/crawler-DESIGN.md:310`) and `discoveredVia: "sitemap"` works
(`tmp/crawler-DESIGN.md:151`). Tolerant, regex-based, no XML dependency; must handle
both `<urlset>` and `<sitemapindex>`, plus the sitemap protocol's plain-text variant.

**Evidence / reuse**
- Sketch: sitemap source row `tmp/crawler-DESIGN.md:254`, robots `Sitemap:` seeding
  `:310`. No prior art (nettle-crawler has none; ecosystem has none,
  `ecosystem.md:14-60`).

**Spec**

```ts
export interface SitemapEntry {
	url: string;              // <loc>, entity-decoded, CDATA-stripped, trimmed
	lastmod?: string;         // verbatim (W3C datetime); caller parses if needed
	changefreq?: string;
	priority?: number;        // parseFloat; dropped when NaN
}

export type SitemapParseResult =
	| { kind: "urlset"; entries: SitemapEntry[] }
	| { kind: "sitemapindex"; sitemaps: { url: string; lastmod?: string }[] };

/** Never throws. Unrecognizable input => { kind: "urlset", entries: [] }. */
export function parseSitemap(text: string): SitemapParseResult;
```

Rules:
- Kind detection: first of `<sitemapindex` / `<urlset` (case-insensitive, namespace
  prefixes tolerated: match `<(\w+:)?urlset`) decides; then extract `<url>…</url>` or
  `<sitemap>…</sitemap>` blocks and, inside each, `<loc>`, `<lastmod>`, `<changefreq>`,
  `<priority>` with tolerant regex; missing/empty `<loc>` → skip the block.
- CDATA (`<![CDATA[…]]>`) and XML entities (`&amp;` etc., same minimal decoder as
  item 6) handled in `<loc>`.
- Plain-text fallback: input containing no `<` → treat as one URL per line (the sitemap
  protocol's text format); blank lines/comments (`#`) skipped; lines that don't start
  with `http` skipped.
- Cap: 50 000 entries (the protocol's own per-file limit), tail dropped.
- Out of scope, documented in JSDoc: RSS/Atom feeds as sitemaps; gzip — `.xml.gz`
  bodies must be gunzipped by the caller before parsing (the crawl loop uses
  `DecompressionStream("gzip")` on page-fetcher's `bytes()`; doc 04 wires it).

**Files**
- `src/extract/sitemap.ts`
- `src/extract/mod.ts` (re-export)
- `tests/extract/sitemap.test.ts`

**Value/Effort/Risk** — med / S / low: opt-in feature, tolerant-by-design; the only
trap (gzip) is explicitly pushed to the caller and documented.

**Implementation notes**
- Block extraction via `indexOf` walking like item 6 (or a bounded non-greedy regex per
  block); never a single greedy regex over a multi-megabyte document.
- Recursion through a sitemapindex is the crawl loop's job (fetch each child, re-parse);
  the parser stays single-document and synchronous.

## Open questions / decisions needed

1. **URLs with userinfo credentials** (`https://user:pass@host/…`): normalizeUrl
   currently keeps them verbatim (losing them would change resource identity), but they
   then flow into the frontier and PG `__crawler_url` keys — persisted credentials.
   Options: keep (spec'd here), strip silently, or reject (`null`). Recommendation:
   keep in `./url` (pure function stays lossless) and let doc 04 decide whether the
   crawl loop refuses or redacts them before enqueue/persist. Needs an owner call
   because it is a security-posture default, not a parsing detail.

Everything else in scope here is closed by the backbone's owner decisions or specified
above.
