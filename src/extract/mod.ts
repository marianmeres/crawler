/**
 * `./extract` — pure, dependency-free extraction of what a fetched document points at.
 *
 * {@linkcode extractLinks} is the centerpiece: a tolerant single-pass HTML scanner (no
 * DOM, no parser dependency) that reports every link occurrence in document order,
 * together with the sectioning landmark it sits in. {@linkcode extractTitle} and
 * {@linkcode extractBaseHref} share the same scanner.
 *
 * The robots half is here too: {@linkcode parseRobotsTxt} turns a robots.txt into an
 * inspectable structure plus a compiled path matcher (and ships the allow-all /
 * disallow-all values the crawl loop's fetch policy needs), while
 * {@linkcode parseMetaRobots} and {@linkcode parseXRobotsTag} read the per-page
 * directives that decide whether a page's links may be followed.
 *
 * Everything here is total: malformed input yields fewer results, never an exception,
 * because a crawler meets malformed input on a normal day.
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

export { parseRobotsTxt, robotsAllowAll, robotsDisallowAll } from "./robots-txt.ts";
export type { RobotsGroup, RobotsRule, RobotsTxt } from "./robots-txt.ts";

export { parseMetaRobots, parseXRobotsTag } from "./meta-robots.ts";
export type { RobotsDirectives } from "./meta-robots.ts";

export type {
	ExtractOptions,
	LinkRegion,
	RawLink,
	RawLinkRel,
	RawLinkTag,
} from "./types.ts";
