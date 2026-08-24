/**
 * `@marianmeres/crawler` — a polite, streaming website crawler for Deno and Node.
 *
 * Point it at a seed URL and iterate the pages as they complete:
 *
 * ```ts
 * import { createCrawler } from "@marianmeres/crawler";
 *
 * const crawler = createCrawler({ maxPages: 500, perHostDelay: 250 });
 * for await (const page of crawler.run("https://example.com")) {
 *     console.log(page.status, page.url, page.links.length);
 * }
 * ```
 *
 * The iterator is backpressured, so a slow consumer slows the crawl rather than filling
 * memory; {@linkcode crawl} is the collect-everything convenience for small runs.
 *
 * Transport is `@marianmeres/page-fetcher` — this package never opens a socket itself,
 * which is also how browser-rendered crawling works: build a page-fetcher browser
 * adapter with your driver and pass the fetcher in.
 *
 * ## Submodules
 *
 * - `@marianmeres/crawler/url` — the pure URL semantics (`normalizeUrl`, `isSameSite`,
 *   `classifyLink`). Dependency-free and useful on its own.
 * - `@marianmeres/crawler/stores` — the frontier/visited persistence seam, for
 *   implementing a custom store.
 *
 * Everything those submodules export that a *consumer* needs is re-exported here.
 *
 * @module
 */

export * from "./crawler.ts";
export * from "./types.ts";
export * from "./url/mod.ts";
export { DEFAULT_USER_AGENT } from "./options.ts";
