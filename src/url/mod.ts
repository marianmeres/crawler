/**
 * `./url` — pure, dependency-free URL semantics for the crawler.
 *
 * This submodule defines what "the same page" means (see {@linkcode normalizeUrl}) and
 * where a link points relative to the page that contains it (see
 * {@linkcode isSameSite}, {@linkcode classifyLink}). It imports nothing, never throws,
 * and is usable entirely standalone.
 *
 * The export list is explicit rather than a `export *`: `normalize-url.ts` also exports
 * one helper marked `@internal` for its own tests, and that must not reach consumers.
 *
 * @module
 */

export {
	DEFAULT_ALLOW_SCHEMES,
	DEFAULT_STRIP_PARAMS,
	normalizeUrl,
} from "./normalize-url.ts";
export type { NormalizeOptions } from "./normalize-url.ts";

export {
	classifyLink,
	getRegistrableDomain,
	hostsAreSameSite,
	isSameSite,
	SECOND_LEVEL_LABELS,
} from "./same-site.ts";
export type { SameSiteOptions, SubdomainsMode } from "./same-site.ts";
