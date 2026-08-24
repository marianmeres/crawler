/**
 * Public types of the `./extract` submodule: what the extractor is told to look for
 * ({@linkcode ExtractOptions}) and one shape it reports back ({@linkcode LinkRegion}).
 *
 * The extractor itself (`extractLinks`, `extractBaseHref`, `extractTitle` and the
 * tolerant HTML scanner behind them) is not written yet; this file exists ahead of it
 * because {@linkcode "../types.ts".CrawlOptions} has to be able to spell `extract`.
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
	/** `<link rel=alternate hreflang>` → rel `"alternate"`. Default `false`. */
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
