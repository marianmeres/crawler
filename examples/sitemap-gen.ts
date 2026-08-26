/**
 * Sitemap generation: crawl a site, print a `sitemap.xml` of what it found.
 *
 * ```sh
 * deno run -A --env-file examples/sitemap-gen.ts https://example.com > sitemap.xml
 * ```
 *
 * @module
 */

import { crawl } from "@marianmeres/crawler";
import type { PageResult } from "@marianmeres/crawler";

/** What this example's `onPage` hook attaches to every result. */
export interface SitemapPageData {
	/** `Last-Modified`, as the `YYYY-MM-DD` a sitemap wants. */
	lastmod?: string;
}

/**
 * A `<urlset>` of the internal HTML pages that answered `200`, in crawl order.
 *
 * A page is listed under the URL it ended up at (its canonical, or the end of its
 * redirect chain), never under the alias that led there, and `noindex` pages are left
 * out — telling a search engine about a page that tells it to go away is pointless.
 */
export function sitemapXml(pages: PageResult[]): string {
	const seen = new Set<string>();
	const entries: string[] = [];

	for (const page of pages) {
		if (!page.ok || page.status !== 200 || page.robots?.noindex) continue;
		if (!(page.contentType ?? "").includes("html")) continue;

		const url = page.canonical ?? page.finalUrl;
		if (seen.has(url)) continue;
		seen.add(url);

		const { lastmod } = (page.data ?? {}) as SitemapPageData;
		entries.push(
			`\t<url><loc>${xml(url)}</loc>` +
				(lastmod ? `<lastmod>${xml(lastmod)}</lastmod>` : "") +
				`</url>`,
		);
	}

	return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.join("\n")}
</urlset>
`;
}

function xml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

if (import.meta.main) {
	const seed = Deno.args[0];
	if (!seed) {
		console.error("usage: deno run -A examples/sitemap-gen.ts <url>");
		Deno.exit(1);
	}

	const report = await crawl(seed, {
		maxPages: 5000,
		perHostDelay: 250,
		// `PageResult` carries no headers — the body and the response are reachable
		// through `ctx.fetchResult`, and whatever the hook returns lands on `page.data`
		onPage: (_res, ctx): SitemapPageData => {
			const modified = ctx.fetchResult?.headers.get("last-modified");
			const date = modified ? new Date(modified) : undefined;
			return date && !Number.isNaN(date.getTime())
				? { lastmod: date.toISOString().slice(0, 10) }
				: {};
		},
	});

	console.log(sitemapXml(report.pages));
}
