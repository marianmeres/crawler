/**
 * `./url` — pure, dependency-free URL semantics for the crawler.
 *
 * This submodule defines what "the same page" means (see {@linkcode normalizeUrl}) and
 * where a link points relative to the page that contains it (see
 * {@linkcode isSameSite}, {@linkcode classifyLink}). It imports nothing, never throws,
 * and is usable entirely standalone.
 *
 * @module
 */

export * from "./normalize-url.ts";
