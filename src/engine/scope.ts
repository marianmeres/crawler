/**
 * Internal — the follow/skip verdict for one discovered link.
 *
 * Every extracted link gets an answer here, and every rejection gets a
 * {@linkcode "../types.ts".SkipReason}: this crawler never drops a link silently,
 * because a crawler that does is impossible to debug ("why did it only fetch 12
 * pages?" has to be answerable from the report, not from a debugger).
 *
 * The function is **pure and synchronous**, which is the whole point of it living in
 * its own file: it covers exactly the checks that need no I/O and no crawl state, so
 * they can be exhaustively unit-tested and so a nav-heavy page short-circuits most of
 * its links before the engine awaits anything. The engine owns the rest of doc 02's
 * check order — `robots-disallow`, `max-depth`/`max-pages`, `trap`, `duplicate` and
 * the user's `shouldVisit` — and applies them, in that order, *after* this returns
 * `follow: true`.
 *
 * @module
 */

import type { LinkRegion } from "../extract/types.ts";
import type { ResolvedScopeOptions } from "../options.ts";
import type { LinkRel, SkipReason } from "../types.ts";
import { hostsAreSameSite } from "../url/same-site.ts";
import { isPrivateHost } from "./private-host.ts";

/**
 * The answer for one link.
 *
 * `checkOnly` rides along on an accepted verdict because this function already knows
 * it and the engine would otherwise recompute it: the URL leaves the crawl's site and
 * was admitted purely by {@linkcode "../types.ts".ScopeOptions.checkExternal}, so it
 * is fetched **once**, with `retainBody: false`, and never expanded.
 */
export type ScopeVerdict =
	| { follow: true; checkOnly: boolean }
	| { follow: false; reason: SkipReason };

/** Everything {@linkcode evaluateScope} needs that is not the URL itself. */
export interface ScopeContext {
	/**
	 * Hostnames of the crawl's seeds — `new URL(seed).hostname`, not whole URLs. The
	 * subdomain rule is evaluated against **these**, not against the referrer, so a
	 * crawl cannot drift off its site one hop at a time.
	 *
	 * An empty list means no host restriction at all (there is nothing to be off).
	 */
	seedHosts: readonly string[];
	/** The resolved scope options — `resolveCrawlOptions(...).scope`. */
	scope: ResolvedScopeOptions;
	/**
	 * Locality of the *edge*, i.e. `classifyLink(referrer, to, { subdomains })`. This
	 * is what {@linkcode "../types.ts".LinkRecord.kind} records; it is referrer-
	 * relative, while {@linkcode seedHosts} is crawl-relative, and a URL that fails
	 * either one is off-site.
	 */
	kind: "internal" | "external";
	/** What the link expresses. Defaults to `"page"`. */
	rel?: LinkRel;
	/** The link carried `rel="nofollow"`, or its source page said so. Default `false`. */
	nofollow?: boolean;
	/** Innermost landmark of this link. Ignored unless `scope.followRegions` is set. */
	region?: LinkRegion;
	/**
	 * `false` when the whole document produced no regioned links — the document-level
	 * fallback, computed once per page by the engine and passed identically for every
	 * link on it. Defaults to `true`, so omitting it never silently disables region
	 * filtering.
	 */
	regionsPresent?: boolean;
	/** Mirrors `CrawlOptions.allowPrivateHosts`. Default `true`. */
	allowPrivateHosts?: boolean;
	/** PSL override for `subdomains: "same-site"`. See `./url`'s `isSameSite`. */
	getRegistrableDomain?: (host: string) => string | null;
}

/**
 * File extensions a page link is not followed to: images, archives, media and fonts.
 *
 * Deliberately not documents — a `.pdf` or a `.csv` is a thing a link check should
 * verify and a thing a consumer may want in `onPage`. What is here is what a *crawler*
 * can only waste bandwidth on: there are no links inside a `.mp4`, and downloading one
 * to find that out is the mistake this list exists to prevent.
 */
export const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
	// images
	"apng",
	"avif",
	"bmp",
	"gif",
	"heic",
	"heif",
	"ico",
	"jpeg",
	"jpg",
	"png",
	"svg",
	"svgz",
	"tif",
	"tiff",
	"webp",
	// archives
	"7z",
	"bz2",
	"gz",
	"rar",
	"tar",
	"tgz",
	"xz",
	"zip",
	"zst",
	// audio + video
	"aac",
	"avi",
	"flac",
	"flv",
	"m4a",
	"m4v",
	"mkv",
	"mov",
	"mp3",
	"mp4",
	"mpeg",
	"mpg",
	"oga",
	"ogg",
	"ogv",
	"opus",
	"wav",
	"webm",
	"wma",
	"wmv",
	// fonts
	"eot",
	"otf",
	"ttf",
	"woff",
	"woff2",
]);

/**
 * Rels that point at a *document* — the ones the extension deny-list applies to.
 * `asset`, `iframe` and `alternate` are opt-in sources, so a caller who turned them on
 * asked for exactly those URLs and is not helped by us second-guessing the extension.
 */
const DOCUMENT_RELS: ReadonlySet<string> = new Set<LinkRel>([
	"page",
	"canonical",
	"next",
	"prev",
	"sitemap",
]);

/** The longest thing we are willing to read as a file extension. */
const MAX_EXTENSION_LENGTH = 8;

// Verdicts are shared frozen values rather than fresh objects: this runs once per
// extracted link, and the union is closed, so there is nothing to allocate.
const FOLLOW: ScopeVerdict = Object.freeze({ follow: true, checkOnly: false });
const FOLLOW_CHECK_ONLY: ScopeVerdict = Object.freeze({ follow: true, checkOnly: true });

const SKIP: Readonly<Record<string, ScopeVerdict>> = Object.freeze(
	Object.fromEntries(
		([
			"bad-scheme",
			"too-long",
			"private-host",
			"out-of-scope",
			"excluded",
			"nofollow",
			"out-of-region",
			"unsupported-type",
		] as const).map((reason) => [
			reason,
			Object.freeze({ follow: false, reason }) as ScopeVerdict,
		]),
	),
);

/**
 * Does any pattern match `href`?
 *
 * A string is a **substring** match on the absolute URL; a `RegExp` is `test`ed against
 * it. An empty string matches everything, which is never what anyone means and is
 * usually a split-an-env-var accident, so it contributes nothing — the same call
 * `./extract` makes about an empty `Allow:` line.
 */
function matchesAny(href: string, patterns: readonly (string | RegExp)[]): boolean {
	for (const pattern of patterns) {
		if (pattern instanceof RegExp) {
			// guard against a caller-supplied /g|y pattern carrying lastIndex state
			if (pattern.global || pattern.sticky) pattern.lastIndex = 0;
			if (pattern.test(href)) return true;
		} else if (typeof pattern === "string" && pattern !== "") {
			if (href.includes(pattern)) return true;
		}
	}
	return false;
}

/** Lowercased extension of the last path segment, or `""` when there is none. */
function extensionOf(pathname: string): string {
	const slash = pathname.lastIndexOf("/");
	const segment = slash < 0 ? pathname : pathname.slice(slash + 1);
	const dot = segment.lastIndexOf(".");
	// `dot <= 0` covers both "no dot" and a dotfile, whose leading dot is not an
	// extension separator
	if (dot <= 0) return "";
	const ext = segment.slice(dot + 1);
	return ext.length > 0 && ext.length <= MAX_EXTENSION_LENGTH ? ext.toLowerCase() : "";
}

/** Is `host` on the site the crawl was seeded at, under the configured mode? */
function onSeedSite(host: string, ctx: ScopeContext): boolean {
	if (ctx.seedHosts.length === 0) return true;
	const opts = {
		subdomains: ctx.scope.subdomains,
		getRegistrableDomain: ctx.getRegistrableDomain,
	};
	for (const seed of ctx.seedHosts) {
		if (hostsAreSameSite(seed, host, opts)) return true;
	}
	return false;
}

/**
 * May this link be followed, and if not, why not?
 *
 * The order is fixed and first-hit-wins, so a report can be read back: `bad-scheme` /
 * `too-long` → `private-host` → `out-of-scope` → `excluded` → `nofollow` →
 * `out-of-region` → `unsupported-type`. It is the pure prefix of doc 02's twelve-step
 * order; the engine continues with the awaited checks after a `follow: true`.
 *
 * Three rules that are easy to get wrong, all deliberate:
 *
 * 1. **`exclude` applies to every URL; `include` and `pathPrefix` only narrow the
 *    crawl's own site.** A deny-list must never be bypassable, but an allow-list that
 *    also filtered externals would silently break `checkExternal` — nobody's external
 *    links start with their `pathPrefix`, so a broken-link check would check nothing.
 * 2. **An include-miss reports `"excluded"`**, not `"out-of-scope"`. Two different
 *    options, one reason, as specified.
 * 3. **`checkOnly` links skip the extension deny-list.** The list exists so a crawler
 *    does not download a 4 GB `.mkv` looking for links in it; a check-only fetch never
 *    retains a body, so the waste it guards against cannot happen and the links most
 *    likely to be broken — big binaries move — stay checkable.
 *
 * Never throws: an unparsable `to` is `bad-scheme`, like any other URL this crawler
 * cannot fetch.
 *
 * @param to The normalized target — a `URL` on the engine's hot path, a string for
 * convenience elsewhere.
 *
 * @example
 * ```ts
 * const scope = resolveCrawlOptions({ scope: { pathPrefix: "/docs" } }).scope;
 * evaluateScope("https://a.com/docs/x", {
 *     seedHosts: ["a.com"], scope, kind: "internal",
 * }); // => { follow: true, checkOnly: false }
 *
 * evaluateScope("https://a.com/blog/x", {
 *     seedHosts: ["a.com"], scope, kind: "internal",
 * }); // => { follow: false, reason: "out-of-scope" }
 * ```
 */
export function evaluateScope(to: string | URL, ctx: ScopeContext): ScopeVerdict {
	const scope = ctx.scope;

	let url: URL;
	if (to instanceof URL) {
		url = to;
	} else {
		try {
			url = new URL(String(to));
		} catch {
			return SKIP["bad-scheme"];
		}
	}

	// 1. bad-scheme / too-long — the transport is HTTP, whatever `normalize` was
	// widened to allow, and a host is what makes a URL fetchable at all
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return SKIP["bad-scheme"];
	}
	if (url.hostname === "") return SKIP["bad-scheme"];
	if (url.href.length > scope.maxUrlLength) return SKIP["too-long"];

	// 2. private-host — best-effort, string-only; see `isPrivateHost`
	if (ctx.allowPrivateHosts === false && isPrivateHost(url.hostname)) {
		return SKIP["private-host"];
	}

	// 3. out-of-scope — off the crawl's site, or outside the requested path
	const offSite = ctx.kind === "external" || !onSeedSite(url.hostname, ctx);
	if (offSite && !scope.allowExternal && !scope.checkExternal) {
		return SKIP["out-of-scope"];
	}
	// admitted purely to be checked: fetched once, body never retained, never expanded
	const checkOnly = offSite && !scope.allowExternal && scope.checkExternal;
	if (
		!offSite && scope.pathPrefix.length > 0 &&
		!scope.pathPrefix.some((prefix) => url.pathname.startsWith(prefix))
	) {
		return SKIP["out-of-scope"];
	}

	// 4. excluded — deny-list first, then the allow-list miss
	if (matchesAny(url.href, scope.exclude)) return SKIP["excluded"];
	if (!offSite && scope.include.length > 0 && !matchesAny(url.href, scope.include)) {
		return SKIP["excluded"];
	}

	// 5. nofollow
	if (ctx.nofollow === true && !scope.followNofollow) return SKIP["nofollow"];

	// 6. out-of-region — subject to the whole-document fallback
	if (scope.followRegions.length > 0 && ctx.regionsPresent !== false) {
		if (ctx.region === undefined || !scope.followRegions.includes(ctx.region)) {
			return SKIP["out-of-region"];
		}
	}

	// 7. unsupported-type
	if (!checkOnly && DOCUMENT_RELS.has(ctx.rel ?? "page")) {
		if (BINARY_EXTENSIONS.has(extensionOf(url.pathname))) {
			return SKIP["unsupported-type"];
		}
	}

	return checkOnly ? FOLLOW_CHECK_ONLY : FOLLOW;
}
