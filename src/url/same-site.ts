/**
 * Link locality — is a URL on the same host, the same site, or somewhere else
 * entirely? This is what the crawler's `subdomains` scope mode is evaluated against
 * and what labels every recorded link edge.
 *
 * This module imports nothing and never throws.
 *
 * @module
 */

/**
 * How permissive "stay on the site" is.
 *
 * - `"same-host"` — exact hostname equality (the crawler's default; `blog.a.com` is a
 *   different host than `a.com`)
 * - `"same-site"` — equal registrable domains (`blog.a.com` and `a.com` match)
 * - `"any"` — anywhere, as long as both URLs parse *and* have a host (a `mailto:` or
 *   `javascript:` target is never in scope for a crawler)
 */
export type SubdomainsMode = "same-host" | "same-site" | "any";

/** Options for {@linkcode isSameSite} and {@linkcode classifyLink}. */
export interface SameSiteOptions {
	/** Default `"same-host"`. */
	subdomains?: SubdomainsMode;
	/**
	 * Public-Suffix-List override used by `"same-site"`: given a lowercase ASCII
	 * hostname, return its registrable domain, or `null` when the host is itself a
	 * public suffix (and so has no registrable domain).
	 *
	 * Default: the built-in {@linkcode getRegistrableDomain} heuristic. Inject a real
	 * PSL-backed implementation when you need exactness — see the caveat there.
	 *
	 * It is called defensively: a throw, or any return that is not a non-empty string,
	 * is treated as "no registrable domain" rather than propagated.
	 */
	getRegistrableDomain?: (host: string) => string | null;
}

/**
 * Second-level labels that, in front of a 2-character ccTLD, form a public suffix:
 * `co.uk`, `com.au`, `gov.sk`, `co.jp`, `or.at`, …
 *
 * This is the entire data set of the built-in heuristic — deliberately a handful of
 * labels rather than a vendored Public Suffix List.
 */
export const SECOND_LEVEL_LABELS: ReadonlySet<string> = new Set([
	"co",
	"com",
	"net",
	"org",
	"gov",
	"edu",
	"ac",
	"mil",
	"sch",
	"ne",
	"or",
	"go",
]);

const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * Registrable domain ("eTLD+1") of a hostname, or `null` when the host IS a public
 * suffix and therefore has none.
 *
 * The rules, in order:
 *
 * 1. an IP literal (`127.0.0.1`, `[::1]`) is returned unchanged — same-site collapses
 *    to same-host for those
 * 2. a single-label host (`localhost`, intranet names) is returned unchanged
 * 3. the last two labels are a public suffix when the last label is 2 characters (a
 *    ccTLD) AND the one before it is in {@linkcode SECOND_LEVEL_LABELS}
 * 4. in that case the registrable domain is the last **three** labels, otherwise the
 *    last **two**
 * 5. if the host is exactly a public suffix (`co.uk`), the answer is `null`
 *
 * A trailing root dot (`a.com.`) is ignored, and the host is lowercased defensively —
 * callers normally pass `new URL(x).hostname`, which is already lowercase ASCII.
 *
 * ## Caveat
 *
 * This heuristic knows nothing about public suffixes that are not
 * `<second-level>.<ccTLD>` — `github.io`, `web.app`, `s3.amazonaws.com`, … Under it,
 * `alice.github.io` and `bob.github.io` compare as the same site. If that matters for
 * your crawl, pass {@linkcode SameSiteOptions.getRegistrableDomain} backed by a real
 * PSL library. The crawler's default scope is `"same-host"`, which never consults this
 * function at all.
 *
 * @example
 * ```ts
 * getRegistrableDomain("www.example.co.uk"); // => "example.co.uk"
 * getRegistrableDomain("blog.example.com");  // => "example.com"
 * getRegistrableDomain("co.uk");             // => null
 * getRegistrableDomain("localhost");         // => "localhost"
 * ```
 */
export function getRegistrableDomain(host: string): string | null {
	if (typeof host !== "string") return null;
	let h = host.trim().toLowerCase();
	if (h === "") return null;

	// `URL.hostname` keeps the brackets around an IPv6 literal.
	if (h.startsWith("[")) return h;

	// the root dot of a fully qualified name is not a label
	if (h.endsWith(".")) h = h.slice(0, -1);
	if (h === "") return null;

	if (IPV4_RE.test(h)) return h;

	const labels = h.split(".");
	if (labels.length === 1) return h;
	if (labels.includes("")) return null; // malformed, e.g. "a..com"

	const tld = labels[labels.length - 1];
	const sld = labels[labels.length - 2];
	const publicSuffixIsTwoLabels = tld.length === 2 && SECOND_LEVEL_LABELS.has(sld);
	const needed = publicSuffixIsTwoLabels ? 3 : 2;

	// the host is itself a public suffix — nothing registrable about it
	if (labels.length < needed) return null;

	return labels.slice(-needed).join(".");
}

/**
 * Hostname of a URL-ish value, or `null` when it has none (unparsable, or opaque).
 * The DNS root label is dropped, matching what `normalizeUrl` writes into the
 * frontier — otherwise `https://a.com./x` would be off-site from `https://a.com/x`.
 */
function hostnameOf(value: string | URL): string | null {
	try {
		const url = value instanceof URL ? value : new URL(String(value));
		if (url.hostname === "") return null;
		let end = url.hostname.length;
		while (end > 0 && url.hostname.charCodeAt(end - 1) === 0x2e) end--;
		return end === 0 ? url.hostname : url.hostname.slice(0, end);
	} catch {
		return null;
	}
}

/**
 * Run a caller-supplied registrable-domain resolver without letting it break this
 * module's never-throws contract, and normalize anything that is not a non-empty
 * string to `null` — a resolver returning `undefined` for two different hosts would
 * otherwise compare equal and make every host same-site.
 */
function resolveRegistrable(
	resolve: (host: string) => string | null,
	host: string,
): string | null {
	try {
		const result = resolve(host);
		return typeof result === "string" && result !== "" ? result : null;
	} catch {
		return null;
	}
}

/**
 * True when `a` and `b` are the "same site" under the given
 * {@linkcode SameSiteOptions.subdomains} mode. Anything that does not parse into a
 * host — a relative reference, `mailto:`, garbage — is never the same site as
 * anything, including itself.
 *
 * Comparison is host-only: scheme and port are ignored, so `http://a.com` and
 * `https://a.com:8443` are the same site.
 *
 * The modes are monotone: whatever `"same-host"` accepts, `"same-site"` accepts, and
 * whatever `"same-site"` accepts, `"any"` accepts. In particular a host with no
 * registrable domain at all (a bare public suffix, or anything an injected PSL does
 * not know) still matches itself under `"same-site"`.
 *
 * @example
 * ```ts
 * isSameSite("https://a.com/x", "https://a.com/y");                          // => true
 * isSameSite("https://a.com/x", "https://blog.a.com/y");                     // => false
 * isSameSite("https://a.com/x", "https://blog.a.com/y", { subdomains: "same-site" });
 * // => true
 * ```
 */
export function isSameSite(
	a: string | URL,
	b: string | URL,
	opts?: SameSiteOptions,
): boolean {
	const hostA = hostnameOf(a);
	const hostB = hostnameOf(b);
	if (hostA === null || hostB === null) return false;

	switch (opts?.subdomains) {
		case "any":
			return true;
		case "same-site": {
			const resolve = opts?.getRegistrableDomain ?? getRegistrableDomain;
			const regA = resolveRegistrable(resolve, hostA);
			const regB = resolveRegistrable(resolve, hostB);
			// No registrable domain (a bare public suffix, or anything an injected
			// PSL does not recognise) falls back to host equality. Widening the mode
			// must never put FEWER urls in scope than "same-host" would — otherwise a
			// crawl seeded at such a host would follow nothing at all.
			if (regA === null || regB === null) return hostA === hostB;
			return regA === regB;
		}
		case "same-host":
		default:
			return hostA === hostB;
	}
}

/**
 * Label a link edge: `"internal"` exactly when {@linkcode isSameSite} says the target
 * belongs to the source's site, `"external"` otherwise (an unresolvable target
 * included).
 *
 * @example
 * ```ts
 * classifyLink("https://a.com/", "https://a.com/about"); // => "internal"
 * classifyLink("https://a.com/", "https://other.com/");  // => "external"
 * ```
 */
export function classifyLink(
	from: string | URL,
	to: string | URL,
	opts?: SameSiteOptions,
): "internal" | "external" {
	return isSameSite(from, to, opts) ? "internal" : "external";
}
