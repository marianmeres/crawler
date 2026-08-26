/**
 * Internal — the log-safe spelling of a URL that may carry userinfo credentials.
 *
 * A URL like `https://user:pass@host/…` stays **verbatim** everywhere it is
 * load-bearing: it is what gets fetched, what keys the frontier and the visited set,
 * and what a `PageResult.url` reports. Such URLs are legitimately crawlable and
 * stripping the credentials would simply break the crawl.
 *
 * The counterpart of that decision is this module: a password must never reach a
 * message. Every site in `src/**` that interpolates a URL into a `logger?.*` call, a
 * warning or an `Error` runs it through {@linkcode maskUserinfo} first — including the
 * sites whose URL provably cannot carry userinfo today, because "every message site is
 * masked" is an invariant a future edit can preserve, while "every message site that
 * could receive a credential" has to be re-derived from the whole call graph each time.
 *
 * Not re-exported from `./url`: it is a logging concern, not URL semantics.
 *
 * @module
 */

/**
 * Replace the password in a URL's userinfo with `***`, leaving everything else — the
 * username included — exactly as it was written.
 *
 * The username survives because it is what makes a masked line useful (*which* account
 * was this?) and the password is the secret. A URL with no password is therefore
 * returned unchanged, `https://user@host/` included.
 *
 * Never throws and never re-serializes: anything that is not a parsable URL is returned
 * as-is, and a URL that is parsable is spliced rather than rebuilt, so the logged
 * spelling stays the spelling that was actually used.
 *
 * @example
 * ```ts
 * maskUserinfo("https://user:s3cret@host/a"); // => "https://user:***@host/a"
 * maskUserinfo("https://user@host/a");        // => "https://user@host/a"
 * maskUserinfo("not a url");                  // => "not a url"
 * ```
 *
 * @internal
 */
export function maskUserinfo(url: string): string {
	if (!url.includes("@")) return url;

	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return url;
	}
	if (parsed.password === "") return url;

	// the authority starts after the scheme's `//` and ends at the first `/`, `?` or `#`
	// (or `\`, which the WHATWG parser reads as `/` for special schemes)
	const authority = url.indexOf("//");
	const rest = authority === -1 ? "" : url.slice(authority + 2);
	const delimiter = rest.search(/[/?#\\]/);
	const end = delimiter === -1 ? url.length : authority + 2 + delimiter;
	// the *last* `@` of the authority is the separator: an earlier one belongs to the
	// userinfo itself (`user:pa@ss@host` → password `pa%40ss`)
	const at = authority === -1 ? -1 : url.lastIndexOf("@", end - 1);

	// a spelling we could not locate the userinfo in (backslash authority separators, a
	// scheme-relative oddity) is rebuilt from the parsed components rather than returned
	// with its password intact
	if (at <= authority + 1) {
		return `${parsed.protocol}//${parsed.username}:***@${parsed.host}` +
			`${parsed.pathname}${parsed.search}${parsed.hash}`;
	}

	const userinfo = url.slice(authority + 2, at);
	const colon = userinfo.indexOf(":");
	const user = colon === -1 ? userinfo : userinfo.slice(0, colon);
	return `${url.slice(0, authority + 2)}${user}:***${url.slice(at)}`;
}
