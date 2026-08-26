/**
 * Scraping: crawl a site and turn every page into a record of your own shape.
 *
 * ```sh
 * deno run -A --env-file examples/scraper.ts https://example.com
 * ```
 *
 * @module
 */

import { createCrawler } from "@marianmeres/crawler";
import type { PageContext, PageResult } from "@marianmeres/crawler";

/** One scraped page. Entirely this example's shape — the crawler has no opinion on it. */
export interface Article {
	url: string;
	title?: string;
	description?: string;
	headings: string[];
}

/**
 * The crawler/scraper boundary, and it runs right here.
 *
 * The package finds, schedules and fetches the pages; `onPage` hands you the response and
 * whatever it returns lands on `PageResult.data`. What the markup *means* is yours — the
 * naive regexes below stand in for the parser you would actually reach for (deno-dom,
 * cheerio, `@marianmeres/html-extract`), none of which this package depends on.
 */
async function scrape(
	res: PageResult,
	ctx: PageContext,
): Promise<Article | undefined> {
	// `PageResult` never carries a body: a 50k-page crawl would not fit in memory. The
	// bytes live on `ctx.fetchResult`, for as long as this hook runs.
	if (!res.ok || !(res.contentType ?? "").includes("html")) return undefined;
	const html = await ctx.fetchResult?.text();
	if (!html) return undefined;

	return {
		url: res.url,
		// already parsed by the crawler on its way past — no need to do it twice
		title: res.title,
		description: metaContent(html, "description"),
		headings: [...html.matchAll(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/gi)]
			.map(([, inner]) => text(inner))
			.filter(Boolean),
	};
}

function metaContent(html: string, name: string): string | undefined {
	const tag = html.match(
		new RegExp(`<meta[^>]+name=["']?${name}["']?[^>]*>`, "i"),
	)?.[0];
	return tag?.match(/content=["']([^"']*)["']/i)?.[1]?.trim() || undefined;
}

function text(fragment: string): string {
	return fragment.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

if (import.meta.main) {
	const seed = Deno.args[0];
	if (!seed) {
		console.error("usage: deno run -A examples/scraper.ts <url>");
		Deno.exit(1);
	}

	const crawler = createCrawler({
		maxPages: 100,
		perHostDelay: 250,
		// crawl the content, not the nav: follow only links inside the page's landmarks
		scope: { followRegions: ["main", "article"] },
		onPage: scrape,
	});

	// streaming, so the scraped rows can go straight into a database instead of an array
	for await (const page of crawler.run(seed)) {
		if (page.data) console.log(JSON.stringify(page.data));
	}
	console.log(`# ${crawler.report()?.stats.done} pages`);
}
