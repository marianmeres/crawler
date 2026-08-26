/**
 * URL normalization — the single definition of "the same page" for this package.
 *
 * Normalization *is* deduplication: the frontier, the visited set and the persistence
 * layer all key on the string this module returns. Get it wrong and a crawl either
 * loops forever on trivially different URLs or misses half a site.
 *
 * Design: lean on the WHATWG `URL` parser for everything it already guarantees
 * (scheme/host lowercasing, IDNA/punycode, default-port stripping, dot-segment
 * resolution) and hand-write only the four things it does not do — percent-encoding
 * canonicalization, query policy, trailing-slash policy and the tracking-param
 * blocklist.
 *
 * This module imports nothing. It never throws: unusable input returns `null`.
 *
 * @module
 */

/** Options for {@linkcode normalizeUrl}. Every step of the pipeline is toggleable. */
export interface NormalizeOptions {
	/**
	 * Scheme allow-list; anything else yields `null`. Entries are compared
	 * case-insensitively and a missing trailing colon is tolerated (`"http"` ===
	 * `"http:"`). Default `["http:", "https:"]`.
	 */
	allowSchemes?: readonly string[];
	/** Strip `#fragment`. Default `true`. */
	stripFragment?: boolean;
	/** When stripping fragments, keep `#!…` hashbang routes. Default `false`. */
	keepHashbang?: boolean;
	/** Canonicalize percent-encoding. Default `true`. */
	normalizeEncoding?: boolean;
	/** Collapse `//` runs in the path (`/a//b` → `/a/b`). Default `true`. */
	collapseSlashes?: boolean;
	/**
	 * Trailing-slash policy; the root `"/"` is never touched. Default `"keep"`.
	 *
	 * `"keep"` is the default because `/x` and `/x/` are not interchangeable: for a
	 * directory-style resource the slash is what makes the page's own relative links
	 * resolve (`../sibling/` is `/dir/../sibling/` from `/dir/`, but `/sibling/` from
	 * `/dir`), which is exactly why servers answer the slashless spelling with a 301
	 * rather than the page. Stripping it therefore asks for a url the site does not
	 * publish, and buys a redirect per page in exchange for a tidier key.
	 *
	 * RFC 3986 §6.2.2 lists the normalizations that are safe on syntax alone — case,
	 * percent-encoding, dot segments — and this is not among them; §6.2.4 puts it in
	 * the class a crawler *learns* by watching `/x` redirect to `/x/`. Which is what
	 * happens here: request what the site published, and let the redirect say when two
	 * spellings are one page.
	 *
	 * `"strip"` remains the right choice for a pure dedup key — comparing urls from
	 * mixed sources, say — where nothing is going to be fetched.
	 */
	trailingSlash?: "strip" | "keep";
	/**
	 * Rebuild the query via `URLSearchParams` (enables the three options below).
	 * Default `true`.
	 */
	normalizeQuery?: boolean;
	/**
	 * Params to drop. A `string` matches the param name case-insensitively and
	 * exactly; a `RegExp` is tested against the name as given.
	 * Default {@linkcode DEFAULT_STRIP_PARAMS}.
	 */
	stripParams?: readonly (string | RegExp)[];
	/** Sort remaining params by name (stable for repeated names). Default `true`. */
	sortParams?: boolean;
	/** Drop params whose value is the empty string. Default `false`. */
	stripEmptyParams?: boolean;
	/**
	 * Strip leading `www.` labels, as long as at least 2 labels remain. Repeated
	 * labels are all stripped (`www.www.a.com` → `a.com`) so the result is a fixed
	 * point. Default `false`.
	 */
	stripWww?: boolean;
	/** Reject (=> `null`) when the final string exceeds this. Default `2048`. */
	maxLength?: number;
}

/**
 * Tracking/session parameters dropped by default. Deliberately opinionated: these
 * never change the resource a URL identifies, but they do multiply it in the frontier.
 *
 * Note `"ref"` is included — if your target site uses `?ref=` meaningfully, pass a
 * custom `stripParams`.
 */
export const DEFAULT_STRIP_PARAMS: readonly (string | RegExp)[] = [
	/^utm_/i,
	"fbclid",
	"gclid",
	"dclid",
	"gbraid",
	"wbraid",
	"msclkid",
	"mc_cid",
	"mc_eid",
	"_ga",
	"_gl",
	"ref",
	"igshid",
	"spm",
	/^(phpsessid|jsessionid|sessionid|session_id|sid)$/i,
];

/** Default {@linkcode NormalizeOptions.allowSchemes}. */
export const DEFAULT_ALLOW_SCHEMES: readonly string[] = ["http:", "https:"];

const DEFAULT_ALLOW_SCHEMES_SET = new Set(DEFAULT_ALLOW_SCHEMES);

/** `A-Z a-z 0-9 - . _ ~` — RFC 3986 unreserved set, as byte values. */
function isUnreservedByte(b: number): boolean {
	return (
		(b >= 0x41 && b <= 0x5a) || // A-Z
		(b >= 0x61 && b <= 0x7a) || // a-z
		(b >= 0x30 && b <= 0x39) || // 0-9
		b === 0x2d || // -
		b === 0x2e || // .
		b === 0x5f || // _
		b === 0x7e //   ~
	);
}

function isHexDigit(c: string): boolean {
	return (
		(c >= "0" && c <= "9") || (c >= "a" && c <= "f") || (c >= "A" && c <= "F")
	);
}

/**
 * Canonicalize percent-encoding in a single URL component (RFC 3986 §6.2.2.2):
 * decode `%XX` triplets whose byte is unreserved, uppercase the hex of every other
 * valid triplet, and repair a stray `%` into `%25`. Everything else passes through.
 *
 * Only single-byte unreserved values decode, so multi-byte UTF-8 sequences
 * (`%C3%A9`) and reserved-purpose triplets (`%2F` in a path, `%26` in a query) stay
 * encoded — which is exactly what keeps the operation semantics-preserving.
 *
 * @internal — exported for tests only.
 */
export function canonPercentEncoding(s: string): string {
	if (s.indexOf("%") === -1) return s;
	let out = "";
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		if (ch !== "%") {
			out += ch;
			continue;
		}
		const h1 = s[i + 1];
		const h2 = s[i + 2];
		if (
			h1 !== undefined && h2 !== undefined && isHexDigit(h1) && isHexDigit(h2)
		) {
			const byte = parseInt(h1 + h2, 16);
			out += isUnreservedByte(byte)
				? String.fromCharCode(byte)
				: "%" + h1.toUpperCase() + h2.toUpperCase();
			i += 2;
		} else {
			// A `%` that does not start a valid triplet is a literal percent sign.
			out += "%25";
		}
	}
	return out;
}

/**
 * Drop the DNS root label(s) from a hostname (`a.com.` → `a.com`). Written as a scan
 * rather than `/\.+$/` so a hostile all-dots host cannot make it backtrack. A host
 * that is nothing but dots is left alone — emitting an empty host would change which
 * resource the url addresses.
 */
function stripRootDots(hostname: string): string {
	let end = hostname.length;
	while (end > 0 && hostname.charCodeAt(end - 1) === 0x2e) end--;
	return end === 0 ? hostname : hostname.slice(0, end);
}

/**
 * Drop every trailing `/` from a path, collapsing a slash-only path back to the root.
 * All of them, not just one: `"/a///"` must reach its fixed point in a single pass
 * even when `collapseSlashes` is off. A scan rather than `/\/+$/`, which backtracks
 * quadratically on a long slash run that does not end in a slash — reachable from any
 * hostile href, and the length cap runs too late to help.
 */
function stripTrailingSlashes(pathname: string): string {
	let end = pathname.length;
	while (end > 0 && pathname.charCodeAt(end - 1) === 0x2f) end--;
	if (end === pathname.length) return pathname;
	return end === 0 ? "/" : pathname.slice(0, end);
}

function normalizeSchemeToken(s: string): string {
	const t = s.trim().toLowerCase();
	return t.endsWith(":") ? t : t + ":";
}

function matchesStripParam(
	name: string,
	patterns: readonly (string | RegExp)[],
): boolean {
	const lower = name.toLowerCase();
	for (const p of patterns) {
		if (typeof p === "string") {
			if (p.toLowerCase() === lower) return true;
		} else {
			// Guard against a caller-supplied /g|y pattern carrying lastIndex state.
			if (p.global || p.sticky) p.lastIndex = 0;
			if (p.test(name)) return true;
		}
	}
	return false;
}

/**
 * Normalize `input` (optionally resolved against `base`) into the package's canonical
 * form, or return `null` when it is not a fetchable URL — unparsable, a disallowed
 * scheme, or longer than {@linkcode NormalizeOptions.maxLength}.
 *
 * The pipeline runs in a fixed order; a disabled step is skipped and the rest still
 * run:
 *
 * 1. trim / parse (`new URL(input, base)`) — no scheme guessing
 * 2. scheme allow-list gate
 * 3. WHATWG-inherent canonicalization (see below) — always on, not toggleable
 * 4. fragment policy
 * 5. `www.` policy
 * 6. percent-encoding canonicalization
 * 7. `//` collapsing in the path
 * 8. trailing-slash policy
 * 9. query policy (strip / sort / drop-empty / re-serialize)
 * 10. manual reassembly
 * 11. length cap
 *
 * Step 3 is what `new URL()` does for us and what therefore *cannot* be turned off:
 * scheme and host lowercasing, IDNA/punycode (`münchen.de` → `xn--mnchen-3ya.de`),
 * default-port stripping (`:80` / `:443`), and `.` / `..` dot-segment resolution
 * (including its `%2e`-encoded spellings). One host step the parser stops short of is
 * also unconditional: the DNS root label is dropped (`a.com.` → `a.com`), because it
 * is not part of a page's identity and keeping it would split one server into two
 * frontier keys.
 *
 * Schemes outside `http:`/`https:` — reachable only by widening
 * {@linkcode NormalizeOptions.allowSchemes} — additionally have their reassembled
 * output re-read and verified; anything the URL parser would interpret differently
 * from what was assembled is rejected as `null` rather than returned unstable.
 *
 * Idempotency — `normalizeUrl(normalizeUrl(x)) === normalizeUrl(x)` — is a required
 * property and is proven by construction, see the note at the bottom of this file.
 *
 * Relative input needs a `base`; schemeless absolute input (`"example.com/x"`) without
 * one is `null` by design — link extraction must never invent a scheme. Seed-level
 * leniency is the crawl engine's concern, not this function's.
 *
 * URLs carrying userinfo (`https://user:pass@host/…`) keep it verbatim: this function
 * is lossless, and refusing or redacting credentials is an enqueue/persist-time
 * policy decision made by the layers above.
 *
 * @example
 * ```ts
 * normalizeUrl("https://Ex.com/a/?utm_source=x&b=2&a=1#top");
 * // => "https://ex.com/a/?a=1&b=2"     (the trailing slash is part of the identity)
 * normalizeUrl("../b", "https://ex.com/x/y/z");
 * // => "https://ex.com/x/b"
 * normalizeUrl("mailto:a@b.com"); // => null
 * ```
 */
export function normalizeUrl(
	input: string,
	base?: string,
	opts?: NormalizeOptions,
): string | null {
	if (typeof input !== "string") return null;
	const trimmed = input.trim();
	if (trimmed === "") return null;

	const o = opts ?? {};
	const stripFragment = o.stripFragment ?? true;
	const keepHashbang = o.keepHashbang ?? false;
	const normalizeEncoding = o.normalizeEncoding ?? true;
	const collapseSlashes = o.collapseSlashes ?? true;
	const trailingSlash = o.trailingSlash ?? "keep";
	const normalizeQuery = o.normalizeQuery ?? true;
	const stripParams = o.stripParams ?? DEFAULT_STRIP_PARAMS;
	const sortParams = o.sortParams ?? true;
	const stripEmptyParams = o.stripEmptyParams ?? false;
	const stripWww = o.stripWww ?? false;
	const maxLength = o.maxLength ?? 2048;

	// 1. parse. A blank/absent base is "no base" (passing "" to `new URL` throws).
	const baseArg = typeof base === "string" && base.trim() !== "" ? base : undefined;
	let url: URL;
	try {
		url = new URL(trimmed, baseArg);
	} catch {
		return null;
	}

	// 2. scheme gate
	const allowed = o.allowSchemes
		? new Set(o.allowSchemes.map(normalizeSchemeToken))
		: DEFAULT_ALLOW_SCHEMES_SET;
	if (!allowed.has(url.protocol)) return null;

	// 3. WHATWG-inherent steps already happened inside `new URL()`.

	// 4. fragment
	let hash = url.hash;
	if (stripFragment && !(keepHashbang && hash.startsWith("#!"))) {
		hash = "";
	} else if (hash !== "" && normalizeEncoding) {
		hash = canonPercentEncoding(hash);
	}

	// 5. host. The DNS root label is not part of the identity of a page, and the
	//    WHATWG parser keeps it, so `a.com.` and `a.com` would otherwise be two
	//    frontier keys for one server. Then the www policy: every leading `www.`
	//    label goes, not just one — otherwise `www.www.a.com` would need two passes
	//    to reach a fixed point.
	let hostname = stripRootDots(url.hostname);
	if (stripWww) {
		while (hostname.startsWith("www.")) {
			const rest = hostname.slice(4);
			if (rest.split(".").length < 2) break;
			hostname = rest;
		}
	}
	const host = url.port ? `${hostname}:${url.port}` : hostname;

	// 6. percent-encoding
	let pathname = url.pathname;
	if (normalizeEncoding) pathname = canonPercentEncoding(pathname);

	// 7. slash runs (a literal `%2F` is a triplet and is never touched)
	if (collapseSlashes) pathname = pathname.replace(/\/{2,}/g, "/");

	// 8. trailing slash
	if (trailingSlash === "strip" && pathname !== "") {
		pathname = stripTrailingSlashes(pathname);
	}

	// 9. query
	let search: string;
	if (normalizeQuery) {
		const kept = new URLSearchParams();
		for (const [name, value] of new URLSearchParams(url.search)) {
			if (stripEmptyParams && value === "") continue;
			if (matchesStripParam(name, stripParams)) continue;
			kept.append(name, value);
		}
		if (sortParams) kept.sort();
		const serialized = kept.toString();
		search = serialized === "" ? "" : "?" + serialized;
	} else {
		search = normalizeEncoding ? canonPercentEncoding(url.search) : url.search;
	}

	// 10. reassemble by hand — assigning back through the `URL` setters would
	//     re-encode what we just canonicalized.
	let userinfo = "";
	if (url.username !== "" || url.password !== "") {
		userinfo = url.username +
			(url.password !== "" ? ":" + url.password : "") + "@";
	}
	const hasAuthority = url.href.slice(url.protocol.length).startsWith("//");
	const out = url.protocol +
		(hasAuthority ? "//" : "") +
		userinfo +
		host +
		pathname +
		search +
		hash;

	// 11. length cap
	if (out.length > maxLength) return null;

	// 12. reassembly guard. Our step-10 join is not the WHATWG serializer; for
	//     http(s) the two provably agree, but a scheme a caller opted into via
	//     `allowSchemes` can break the join in ways that silently change which
	//     resource is addressed — an opaque path that keeps raw spaces (`mailto:`,
	//     `data:`), a non-numeric `url.port` (`git:/.//x`), a `file:` path whose
	//     first segment looks like a Windows drive letter and drops the host. So for
	//     those schemes only, re-read our own output and refuse it unless every
	//     component survived. The hot path stays at exactly one `URL` parse.
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		let roundTrip: URL;
		try {
			roundTrip = new URL(out);
		} catch {
			return null;
		}
		if (
			roundTrip.protocol !== url.protocol ||
			roundTrip.username !== url.username ||
			roundTrip.password !== url.password ||
			roundTrip.hostname !== hostname ||
			roundTrip.port !== url.port ||
			roundTrip.pathname !== pathname ||
			roundTrip.search !== search ||
			roundTrip.hash !== hash
		) {
			return null;
		}
	}

	return out;
}

/*
 * Why the output is a fixed point (the idempotency proof the design requires):
 *
 * Re-normalizing our own output re-parses it with `new URL()` and re-runs every step.
 * For the result to differ, some step would have to find something left to change:
 *
 * - Parsing: the output only contains (a) unreserved literals, which no WHATWG
 *   percent-encode set touches, (b) uppercase `%XX` triplets, which the parser
 *   preserves verbatim, and (c) `URLSearchParams` output, which is a fixed point
 *   under parse/serialize (`+` decodes to a space and re-encodes to `+`). So the
 *   parser reproduces exactly the components we emitted.
 * - Dot segments: the parser resolves `.`/`..` — including the `%2e` spellings — at
 *   parse time, *before* our decoding step ever runs. Any `%2E` still present after
 *   parsing therefore sits inside a longer segment (`%2e%2e%2e`, `x%2e.`), and
 *   decoding it cannot produce a segment that is exactly `.` or `..`.
 * - Host, port, scheme, IDN: already canonical, and neither the `www.` step nor the
 *   host rebuild can re-introduce what they removed.
 * - Percent-encoding: every triplet left is non-unreserved and already uppercase;
 *   every `%` left starts a valid triplet.
 * - Slashes / trailing slash: both transforms are global and leave no match behind.
 * - Query: re-parsing the serialized query yields the same name/value pairs in the
 *   same order, and sorting an already sorted list is a no-op.
 * - Length: a fixed point cannot grow past the cap it already passed.
 * - Host: the root-label and `www.` steps are loops, so they leave no match behind,
 *   and neither can re-introduce a label it removed.
 *
 * That argument is specific to hierarchical, authority-bearing urls — which is all
 * `http:`/`https:` can be. Widen `allowSchemes` and it stops holding: an opaque path
 * (`mailto:`, `data:`) can carry raw whitespace the parser strips, `url.port` is not
 * necessarily numeric, and `file:` re-reads a leading drive-letter segment as a
 * reason to drop the host. Step 12 therefore re-parses the output for every
 * non-http(s) scheme and rejects whatever does not survive verbatim.
 *
 * The property test in `tests/url/normalize-url-property.test.ts` checks this over a
 * seeded corpus rather than trusting the argument alone.
 */
