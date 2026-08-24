/**
 * Turning a fetched document into candidate links, a title, and an effective base URL —
 * without a DOM, without a dependency, and without ever throwing.
 *
 * The design in one line: **extract everything, filter nothing.** A `javascript:` href,
 * an off-site target, a `nofollow` link and a duplicate all come back like any other
 * occurrence, in document order. Deciding what to follow is the crawl loop's job, and it
 * has to *record* the links it rejects — a link graph missing its external edges is not
 * a link graph. The one thing dropped here is an empty href.
 *
 * @module
 */

import {
	collapseWhitespace,
	decodeEntities,
	findCloseTagIndex,
	parseAttrs,
	scanTokens,
	textOf,
} from "./_html.ts";
import type {
	ExtractOptions,
	LinkRegion,
	RawLink,
	RawLinkRel,
	RawLinkTag,
} from "./types.ts";

/**
 * The documented {@linkcode ExtractOptions} defaults, in one executable place.
 *
 * `resolveCrawlOptions` reads them too, so the crawler's option table and a standalone
 * {@linkcode extractLinks} call can never disagree about what "default" means.
 */
export const DEFAULT_EXTRACT_OPTIONS: Readonly<Required<ExtractOptions>> = Object
	.freeze({
		anchors: true,
		canonical: true,
		nextPrev: true,
		metaRefresh: true,
		alternate: false,
		iframes: false,
		assets: false,
		srcset: false,
		maxAnchorText: 200,
		maxLinks: 10_000,
	});

/** Default cap for {@linkcode extractTitle}. */
export const DEFAULT_TITLE_MAX_LENGTH = 512;

/** {@linkcode ExtractOptions} plus the one knob only the engine needs. */
export interface ExtractLinksOptions extends ExtractOptions {
	/**
	 * Honor a `<base href>` found in `html`. Default `true`.
	 *
	 * The engine sets it `false` for the body pass of a
	 * {@linkcode "../types.ts".CrawlOptions.beforeExtract} crawl: `<base>` lives in
	 * `<head>`, which narrowing has already removed, so the body pass is *handed* the
	 * effective base computed from the raw document and must not go looking for another
	 * one. Re-deriving it there would silently resolve every relative link on the page
	 * against the wrong path.
	 */
	detectBase?: boolean;
}

/** The six sectioning landmarks {@linkcode LinkRegion} tracks. */
const LANDMARKS: ReadonlySet<string> = new Set<LinkRegion>([
	"main",
	"article",
	"nav",
	"header",
	"footer",
	"aside",
]);

/**
 * Landmark nesting we are willing to remember. Six landmark elements nested 64 deep is
 * not a document, it is an attempt to grow our stack; past this the innermost-wins rule
 * degrades rather than the memory.
 */
const MAX_REGION_DEPTH = 64;

/** How far past an `<a>` we look for its `</a>` before giving up on the text. */
const ANCHOR_TEXT_WINDOW = 4096;

/** Same, for `<title>`. */
const TITLE_WINDOW = 4096;

const NO_RELS: ReadonlySet<string> = new Set<string>();

/**
 * Options are never a reason to throw here — this function is documented as total, and
 * the engine's `resolveCrawlOptions` is where a nonsensical value is an error. An
 * out-of-range number falls back to the default.
 *
 * The result is a whole number (`Infinity` included): these caps size and index arrays,
 * and `links.length = 0.5` is a `RangeError`, not a small cap. A value that floors to
 * `0` is out of range like any other zero.
 */
function positiveOr(value: number | undefined, fallback: number): number {
	if (typeof value !== "number" || Number.isNaN(value) || value <= 0) return fallback;
	const whole = Math.floor(value);
	return whole > 0 ? whole : fallback;
}

/** Same, but `0` is meaningful — it is how anchor-text collection is turned off. */
function nonNegativeOr(value: number | undefined, fallback: number): number {
	if (typeof value !== "number" || Number.isNaN(value) || value < 0) return fallback;
	return Math.floor(value);
}

/** Whitespace- and comma-separated `rel` tokens, lowercased. */
function relTokens(value: string | undefined): ReadonlySet<string> {
	if (!value) return NO_RELS;
	const tokens = value.toLowerCase().split(/[\s,]+/).filter(Boolean);
	return tokens.length > 0 ? new Set(tokens) : NO_RELS;
}

/** Cap without splitting a surrogate pair down the middle. */
function capText(text: string, max: number): string {
	if (text.length <= max) return text;
	let cut = max;
	const last = text.charCodeAt(cut - 1);
	if (last >= 0xd800 && last <= 0xdbff) cut--;
	return text.slice(0, cut);
}

/**
 * The URL out of a `<meta http-equiv=refresh>` `content` value, tolerantly:
 * `5; url=/next`, `0,/next`, `5; URL='/next'`, and the delay-less `url=/next` all work;
 * a bare delay (`5`) has no URL and yields nothing.
 */
function parseMetaRefreshUrl(content: string): string | undefined {
	const sep = /[;,]/.exec(content);
	let rest = (sep ? content.slice(sep.index + 1) : content).trim();

	const prefix = /^url\s*=\s*/i.exec(rest);
	if (prefix) rest = rest.slice(prefix[0].length).trim();
	else if (!sep) return undefined; // "5" is a delay, not a URL

	const q = rest.charCodeAt(0);
	if (
		rest.length > 1 && (q === 0x22 || q === 0x27) &&
		rest.charCodeAt(rest.length - 1) === q
	) {
		rest = rest.slice(1, -1).trim();
	}
	return rest === "" ? undefined : rest;
}

/**
 * URLs out of a `srcset`: split on `,`, keep the first whitespace-delimited token of
 * each candidate.
 *
 * Known tolerance: a URL that itself contains a comma and carries no descriptor — a
 * `data:` URI, most realistically — mis-splits. Handling that needs the full srcset
 * grammar, and lenient consumers in the wild split the same way.
 */
function srcsetCandidates(value: string | undefined): string[] {
	if (!value) return [];
	const out: string[] = [];
	for (const candidate of value.split(",")) {
		const url = candidate.trim().split(/\s+/)[0];
		if (url) out.push(url);
	}
	return out;
}

/**
 * Push/pop the landmark stack, tolerating markup that does not balance: a close with no
 * matching open is ignored, and a close that matches something deeper down pops
 * everything above it too (an unclosed `<nav>` inside `<main>` ends at `</main>`).
 */
function trackRegion(
	stack: LinkRegion[],
	name: LinkRegion,
	closing: boolean,
	selfClosing: boolean,
): void {
	if (closing) {
		for (let i = stack.length - 1; i >= 0; i--) {
			if (stack[i] === name) {
				stack.length = i;
				return;
			}
		}
		return;
	}
	if (selfClosing) return;
	if (stack.length < MAX_REGION_DEPTH) stack.push(name);
}

/** Text of the `<a>` that opened at `from`, capped both in window and in length. */
function anchorTextAt(html: string, from: number, max: number): string | undefined {
	if (max <= 0) return undefined;
	const limit = Math.min(html.length, from + ANCHOR_TEXT_WINDOW);
	const close = findCloseTagIndex(html, "a", from, limit);
	const raw = html.slice(from, close < 0 ? limit : close);
	const text = capText(collapseWhitespace(decodeEntities(textOf(raw))), max);
	return text === "" ? undefined : text;
}

/** Absolute base to resolve hrefs against, or `undefined` when there is none. */
function effectiveBase(
	baseHref: string | undefined,
	baseUrl: string,
): string | undefined {
	let root: string | undefined;
	try {
		root = new URL(baseUrl).href;
	} catch {
		root = undefined;
	}
	if (baseHref === undefined) return root;
	try {
		// an absolute <base href> stands on its own even when baseUrl was garbage
		return root === undefined ? new URL(baseHref).href : new URL(baseHref, root).href;
	} catch {
		return root;
	}
}

/**
 * Every link in `html`, in document order, resolved against `baseUrl`.
 *
 * Which sources are looked at is {@linkcode ExtractOptions}; the defaults follow *pages*
 * (anchors, canonical, prev/next, meta-refresh) and leave assets, iframes and alternates
 * to the use cases that want them.
 *
 * Occurrences are **not** deduped and nothing is filtered out — see {@linkcode RawLink}.
 * The effective base is the first `<base href>` in the document (resolved against
 * `baseUrl`), which governs *all* links including those written before it, exactly as in
 * a browser.
 *
 * Never throws: malformed markup yields fewer links, not an error. Bad options fall back
 * to their defaults rather than raising.
 *
 * @example
 * ```ts
 * const links = extractLinks(
 *     `<main><a href="/about" rel="nofollow">About</a></main>`,
 *     "https://example.com/blog/",
 * );
 * // => [{ href: "/about", url: "https://example.com/about", tag: "a", rel: "page",
 * //       nofollow: true, ugc: false, sponsored: false, region: "main",
 * //       anchorText: "About" }]
 * ```
 */
export function extractLinks(
	html: string,
	baseUrl: string,
	opts?: ExtractLinksOptions,
): RawLink[] {
	if (typeof html !== "string" || html === "") return [];

	const anchors = opts?.anchors ?? DEFAULT_EXTRACT_OPTIONS.anchors;
	const canonical = opts?.canonical ?? DEFAULT_EXTRACT_OPTIONS.canonical;
	const nextPrev = opts?.nextPrev ?? DEFAULT_EXTRACT_OPTIONS.nextPrev;
	const metaRefresh = opts?.metaRefresh ?? DEFAULT_EXTRACT_OPTIONS.metaRefresh;
	const alternate = opts?.alternate ?? DEFAULT_EXTRACT_OPTIONS.alternate;
	const iframes = opts?.iframes ?? DEFAULT_EXTRACT_OPTIONS.iframes;
	const assets = opts?.assets ?? DEFAULT_EXTRACT_OPTIONS.assets;
	const srcset = opts?.srcset ?? DEFAULT_EXTRACT_OPTIONS.srcset;
	const detectBase = opts?.detectBase ?? true;
	const maxAnchorText = nonNegativeOr(
		opts?.maxAnchorText,
		DEFAULT_EXTRACT_OPTIONS.maxAnchorText,
	);
	const maxLinks = positiveOr(opts?.maxLinks, DEFAULT_EXTRACT_OPTIONS.maxLinks);

	const links: RawLink[] = [];
	const regions: LinkRegion[] = [];
	let baseHref: string | undefined;

	const add = (
		tag: RawLinkTag,
		rel: RawLinkRel,
		value: string | undefined,
		rels: ReadonlySet<string> = NO_RELS,
		extras?: { anchorText?: string; hreflang?: string },
	): void => {
		const href = value?.trim();
		if (!href) return;
		const link: RawLink = {
			href,
			tag,
			rel,
			nofollow: rels.has("nofollow"),
			ugc: rels.has("ugc"),
			sponsored: rels.has("sponsored"),
		};
		if (regions.length > 0) link.region = regions[regions.length - 1];
		if (extras?.anchorText !== undefined) link.anchorText = extras.anchorText;
		if (extras?.hreflang) link.hreflang = extras.hreflang;
		links.push(link);
	};

	try {
		for (const token of scanTokens(html)) {
			if (token.kind !== "tag") continue;
			const name = token.name;

			if (LANDMARKS.has(name)) {
				trackRegion(
					regions,
					name as LinkRegion,
					token.closing,
					token.selfClosing,
				);
				continue; // a landmark is structure, never a link source
			}
			if (token.closing) continue;
			// The tail past the cap is dropped silently. A `<base>` that late is
			// invalid HTML anyway (it belongs in `<head>`), so it is not honored.
			if (links.length >= maxLinks) break;

			switch (name) {
				case "base": {
					if (detectBase && baseHref === undefined) {
						const href = parseAttrs(token.attrsSource).get("href")
							?.trim();
						if (href) baseHref = href;
					}
					break;
				}
				case "a":
				case "area": {
					if (!anchors) break;
					const attrs = parseAttrs(token.attrsSource);
					add(name, "page", attrs.get("href"), relTokens(attrs.get("rel")), {
						anchorText: name === "a"
							? anchorTextAt(html, token.end, maxAnchorText)
							: undefined,
					});
					break;
				}
				case "link": {
					const attrs = parseAttrs(token.attrsSource);
					const href = attrs.get("href");
					if (!href) break;
					const rels = relTokens(attrs.get("rel"));
					// one <link> is one edge: first match in this order wins
					if (rels.has("canonical")) {
						if (canonical) add("link", "canonical", href, rels);
					} else if (rels.has("next")) {
						if (nextPrev) add("link", "next", href, rels);
					} else if (rels.has("prev") || rels.has("previous")) {
						if (nextPrev) add("link", "prev", href, rels);
					} else if (rels.has("stylesheet")) {
						if (assets) add("link", "asset", href, rels);
					} else if (rels.has("alternate")) {
						if (alternate) {
							add("link", "alternate", href, rels, {
								hreflang: attrs.get("hreflang")?.trim(),
							});
						}
					}
					break;
				}
				case "meta": {
					if (!metaRefresh) break;
					const attrs = parseAttrs(token.attrsSource);
					const equiv = attrs.get("http-equiv")?.trim().toLowerCase();
					if (equiv !== "refresh") break;
					add("meta", "page", parseMetaRefreshUrl(attrs.get("content") ?? ""));
					break;
				}
				case "iframe":
				case "frame": {
					if (!iframes) break;
					add(name, "iframe", parseAttrs(token.attrsSource).get("src"));
					break;
				}
				case "img":
				case "source": {
					if (!assets && !srcset) break;
					const attrs = parseAttrs(token.attrsSource);
					if (assets) add(name, "asset", attrs.get("src"));
					if (srcset) {
						for (const url of srcsetCandidates(attrs.get("srcset"))) {
							add(name, "asset", url);
						}
					}
					break;
				}
				case "script": {
					if (!assets) break;
					add("script", "asset", parseAttrs(token.attrsSource).get("src"));
					break;
				}
				case "video": {
					if (!assets) break;
					const attrs = parseAttrs(token.attrsSource);
					add("video", "asset", attrs.get("src"));
					add("video", "asset", attrs.get("poster"));
					break;
				}
				case "audio": {
					if (!assets) break;
					add("audio", "asset", parseAttrs(token.attrsSource).get("src"));
					break;
				}
			}
		}
	} catch {
		// never throws — whatever was collected before the surprise still stands
	}

	// a single tag can contribute several links (srcset), so trim once at the end
	if (links.length > maxLinks) links.length = maxLinks;

	const base = effectiveBase(baseHref, typeof baseUrl === "string" ? baseUrl : "");
	if (base !== undefined) {
		for (const link of links) {
			try {
				link.url = new URL(link.href, base).href;
			} catch {
				// stays undefined — a href no parser can make sense of
			}
		}
	}

	return links;
}

/**
 * The base URL that `html`'s relative links resolve against: the first `<base href>`
 * resolved against `baseUrl`, or `baseUrl` itself when the document has none (or when
 * the one it has does not resolve).
 *
 * {@linkcode extractLinks} does this itself. Call it separately when extraction runs
 * over *narrowed* HTML — `<base>` lives in `<head>` and narrowing throws `<head>` away,
 * so the base has to be computed from the raw document and handed to the body pass.
 *
 * Never throws.
 */
export function extractBaseHref(html: string, baseUrl: string): string {
	if (typeof html !== "string" || html === "") return baseUrl;
	try {
		for (const token of scanTokens(html)) {
			if (token.kind !== "tag" || token.closing || token.name !== "base") {
				continue;
			}
			const href = parseAttrs(token.attrsSource).get("href")?.trim();
			if (!href) continue; // <base target=...> is not a base href
			try {
				return new URL(href, baseUrl).href;
			} catch {
				return baseUrl;
			}
		}
	} catch {
		// never throws
	}
	return baseUrl;
}

/**
 * The document's `<title>`: entity-decoded, whitespace-collapsed, trimmed and capped
 * (default {@linkcode DEFAULT_TITLE_MAX_LENGTH}). `undefined` when there is none, or
 * when it is empty.
 *
 * The first `<title>` wins, and a `<title>` inside `<svg>` — an accessibility label, not
 * a document title — is skipped. Never throws.
 */
export function extractTitle(
	html: string,
	opts?: { maxLength?: number },
): string | undefined {
	if (typeof html !== "string" || html === "") return undefined;
	const max = positiveOr(opts?.maxLength, DEFAULT_TITLE_MAX_LENGTH);

	try {
		let svgDepth = 0;
		for (const token of scanTokens(html)) {
			if (token.kind !== "tag") continue;

			if (token.name === "svg") {
				if (token.closing) svgDepth = Math.max(0, svgDepth - 1);
				else if (!token.selfClosing) svgDepth++;
				continue;
			}
			if (
				token.name !== "title" || token.closing || token.selfClosing ||
				svgDepth > 0
			) {
				continue;
			}

			const limit = Math.min(html.length, token.end + TITLE_WINDOW);
			const close = findCloseTagIndex(html, "title", token.end, limit);
			const raw = html.slice(token.end, close < 0 ? limit : close);
			const text = capText(
				collapseWhitespace(decodeEntities(textOf(raw))),
				max,
			);
			return text === "" ? undefined : text;
		}
	} catch {
		// never throws
	}
	return undefined;
}
