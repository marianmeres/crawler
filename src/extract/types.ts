/**
 * Public types of the `./extract` submodule: what the extractor is told to look for
 * ({@linkcode ExtractOptions}) and what it reports back ({@linkcode RawLink},
 * {@linkcode LinkRegion}).
 *
 * The extractor itself lives next door in `extract-links.ts`; the types are here
 * because {@linkcode "../types.ts".CrawlOptions} has to be able to spell `extract`
 * without pulling the scanner in.
 *
 * @module
 */

/**
 * Sectioning landmark a link was found inside, when the document uses semantic HTML.
 *
 * Always the **innermost** enclosing landmark, which is what makes it useful: a `<nav>`
 * nested inside `<main>` — an in-page table of contents, a docs sidebar — reports
 * `"nav"`, not `"main"`, so {@linkcode "../types.ts".ScopeOptions.followRegions} can
 * skip it. The cost is that an `<article><header>` byline reports `"header"` and is
 * treated as chrome; that is the deliberate trade.
 *
 * `undefined` on a {@linkcode "../types.ts".LinkRecord} means the link was inside none
 * of these — div-soup markup, or a link sitting directly in `<body>`.
 *
 * Tracking is unconditional: it costs a small tag-depth stack in a scanner that is
 * already tracking tag boundaries, so there is no option to turn it off.
 */
export type LinkRegion =
	| "main"
	| "article"
	| "nav"
	| "header"
	| "footer"
	| "aside";

/**
 * Which link sources the extractor looks at, and its two safety caps.
 *
 * The defaults are deliberately conservative: a crawl follows *pages*, so anchors,
 * canonicals, prev/next and meta-refresh are on, while assets, iframes and translation
 * alternates are opt-in. Turning `assets`/`srcset` on is what the broken-link-checker
 * use case needs.
 */
export interface ExtractOptions {
	/** `<a href>`, `<area href>` → rel `"page"`. Default `true`. */
	anchors?: boolean;
	/** `<link rel=canonical>` → rel `"canonical"`. Default `true`. */
	canonical?: boolean;
	/** `<link rel=next|prev>` → rel `"next"`/`"prev"`. Default `true`. */
	nextPrev?: boolean;
	/** `<meta http-equiv=refresh content="5; url=…">` → rel `"page"`. Default `true`. */
	metaRefresh?: boolean;
	/**
	 * `<link rel=alternate>` → rel `"alternate"`, with `hreflang` recorded when the tag
	 * has one. Default `false`. Feed links (`rel="alternate" type="application/rss+xml"`)
	 * come along, which is the point for a feed-discovery crawl; a
	 * `rel="alternate stylesheet"` does not — that one is a stylesheet.
	 */
	alternate?: boolean;
	/** `<iframe src>`, `<frame src>` → rel `"iframe"`. Default `false`. */
	iframes?: boolean;
	/**
	 * `img`/`script`/`source`/`video`/`audio` `src` (+ `poster`) and
	 * `<link rel=stylesheet>` → rel `"asset"`. Default `false`.
	 */
	assets?: boolean;
	/** `srcset` candidates on `img`/`source` → rel `"asset"`. Default `false`. */
	srcset?: boolean;
	/** Anchor-text cap, in characters. Default `200`. */
	maxAnchorText?: number;
	/** Hard cap on links returned per document; the tail is dropped. Default `10_000`. */
	maxLinks?: number;
}

/**
 * Element a link was found on. A closed list on purpose: a new source is an
 * {@linkcode ExtractOptions} change, not a heuristic that silently starts firing.
 */
export type RawLinkTag =
	| "a"
	| "area"
	| "link"
	| "iframe"
	| "frame"
	| "meta"
	| "img"
	| "script"
	| "source"
	| "video"
	| "audio";

/**
 * The kind of relationship a raw link expresses. This is
 * {@linkcode "../types.ts".LinkRel} minus `"sitemap"` — a sitemap URL never came from
 * markup, so the extractor can never produce one.
 */
export type RawLinkRel =
	| "page"
	| "asset"
	| "canonical"
	| "alternate"
	| "next"
	| "prev"
	| "iframe";

/**
 * One link occurrence, exactly as the document had it.
 *
 * "Occurrence", not "URL": the extractor preserves document order and does **not**
 * dedupe, because the same target linked from the nav and from the body is two edges of
 * the link graph. It also does not filter — a `javascript:` href or an off-site target
 * comes back like any other, and the crawl loop is what decides (and records *why*) a
 * link is not followed.
 */
export interface RawLink {
	/** The attribute value as written, entity-decoded and trimmed. Never empty. */
	href: string;
	/**
	 * `href` resolved against the effective base. `undefined` when it does not resolve
	 * — a malformed href, or a base URL that is not absolute.
	 */
	url?: string;
	tag: RawLinkTag;
	rel: RawLinkRel;
	/** `rel` attribute contained `nofollow`. */
	nofollow: boolean;
	/** `rel` attribute contained `ugc` (user-generated content). */
	ugc: boolean;
	/** `rel` attribute contained `sponsored`. */
	sponsored: boolean;
	/**
	 * Innermost enclosing landmark, when the document has one. See
	 * {@linkcode LinkRegion}.
	 */
	region?: LinkRegion;
	/**
	 * `<a>` only: the link's text, entity-decoded, whitespace-collapsed, trimmed and
	 * capped at {@linkcode ExtractOptions.maxAnchorText}. `undefined` when the link has
	 * no text (an image link, an empty anchor) or when the cap is `0`.
	 */
	anchorText?: string;
	/** `<link rel=alternate>` only, when the tag carries an `hreflang`. */
	hreflang?: string;
}
