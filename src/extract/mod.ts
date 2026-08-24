/**
 * `./extract` — pure, dependency-free extraction of what a fetched document points at.
 *
 * {@linkcode extractLinks} is the centerpiece: a tolerant single-pass HTML scanner (no
 * DOM, no parser dependency) that reports every link occurrence in document order,
 * together with the sectioning landmark it sits in. {@linkcode extractTitle} and
 * {@linkcode extractBaseHref} share the same scanner.
 *
 * Everything here is total: malformed markup yields fewer results, never an exception,
 * because a crawler meets malformed markup on a normal day.
 *
 * The export list is explicit rather than an `export *` — the scanner in `_html.ts` is
 * internal, and a wildcard is how internals become public promises.
 *
 * @module
 */

export {
	DEFAULT_EXTRACT_OPTIONS,
	DEFAULT_TITLE_MAX_LENGTH,
	extractBaseHref,
	extractLinks,
	extractTitle,
} from "./extract-links.ts";
export type { ExtractLinksOptions } from "./extract-links.ts";

export type {
	ExtractOptions,
	LinkRegion,
	RawLink,
	RawLinkRel,
	RawLinkTag,
} from "./types.ts";
