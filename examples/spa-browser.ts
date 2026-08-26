/**
 * Crawling a site that renders itself in the browser: HTTP where that is enough, a real
 * browser where it is not.
 *
 * ```sh
 * deno run -A --env-file examples/spa-browser.ts https://example.com
 * ```
 *
 * The browser adapter hands back `page.content()` **after** the wait strategy resolved —
 * the serialized, post-JS DOM. That one fact is what makes the whole thing work: those are
 * the bytes `extractLinks` sees (so JS-injected links are discovered and followed), the
 * bytes `contentHash` is computed over, and the bytes `./pg`'s `persistBody` archives.
 *
 * Playwright is **yours**, never this package's: neither the crawler nor page-fetcher
 * imports a browser. Install it, or this example exits with a message.
 *
 * @module
 */

import { createCrawler } from "@marianmeres/crawler";
import { createFetcher } from "@marianmeres/page-fetcher";
import {
	createBrowserAdapter,
	createHttpAdapter,
	playwrightDriver,
} from "@marianmeres/page-fetcher/adapters";
import type { PlaywrightSource } from "@marianmeres/page-fetcher/adapters";

/** The routes whose content is rendered client-side. Everything else stays on HTTP. */
const NEEDS_JS = /^\/(app|dashboard|search)(\/|$)/;

async function loadPlaywright(): Promise<PlaywrightSource | undefined> {
	// deliberately not a literal: a static specifier would make playwright something
	// `deno check` has to resolve, and it is not a dependency of anything here
	const specifier = "npm:playwright";
	try {
		return await import(specifier);
	} catch {
		return undefined;
	}
}

if (import.meta.main) {
	const seed = Deno.args[0];
	if (!seed) {
		console.error("usage: deno run -A examples/spa-browser.ts <url>");
		Deno.exit(1);
	}

	const playwright = await loadPlaywright();
	if (!playwright) {
		console.error(
			"This example needs Playwright, which is yours to install — browser drivers " +
				"are never a dependency of this package:\n\n" +
				"    deno add npm:playwright\n" +
				"    deno run -A npm:playwright install chromium\n",
		);
		Deno.exit(0);
	}

	await using fetcher = createFetcher({
		// the first adapter is the default route, the rest are reachable by name
		adapters: [
			createHttpAdapter(),
			createBrowserAdapter({
				driver: playwrightDriver(playwright),
				// the default "networkidle" is a soft wait: on a busy page the quiet
				// window may never arrive, and it then proceeds anyway and says so in
				// `extra.networkidleTimedOut`. A selector is the strategy that knows.
				wait: { selector: "[data-app-ready], main article", timeout: 15_000 },
			}),
		],
		// per request, with the full FetchRequest in hand. robots.txt and every static
		// page keep going through HTTP — rendering a text file helps nobody.
		selectAdapter: (req) =>
			NEEDS_JS.test(new URL(req.url).pathname) ? "browser" : "http",
	});

	// an injected fetcher is never disposed by the engine: you built it, you own it
	const crawler = createCrawler({ fetcher, maxPages: 100, perHostDelay: 500 });

	for await (const page of crawler.run(seed)) {
		console.log(page.status, page.url, `${page.links.length} links`);
	}
}
