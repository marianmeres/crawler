/**
 * Broken-link report: every dead target of a crawl, with the pages linking to it.
 *
 * ```sh
 * deno run -A --env-file example/recipes/broken-links.ts https://example.com
 * ```
 *
 * @module
 */

import { crawl } from "@marianmeres/crawler";
import type { LinkRecord, PageResult } from "@marianmeres/crawler";

/** One dead target and every page that points at it. */
export interface BrokenLink {
	url: string;
	/** Absent when the fetch failed before a response — see {@linkcode BrokenLink.error}. */
	status?: number;
	error?: string;
	/** Pages linking to it, sorted. */
	from: string[];
}

/**
 * Group a crawl's link graph by dead target, most-linked first.
 *
 * Only a target the crawl actually fetched can be judged, so what the crawl covered
 * decides what this can report: `extract.assets` to see broken images and stylesheets,
 * `scope.checkExternal` to see dead outbound links.
 */
export function brokenLinkReport(
	graph: LinkRecord[],
	pages: PageResult[],
): BrokenLink[] {
	const dead = new Map<string, PageResult>();
	for (const page of pages) {
		if (!page.ok) dead.set(page.url, page);
	}

	const sources = new Map<string, Set<string>>();
	for (const link of graph) {
		if (!dead.has(link.to)) continue;
		let from = sources.get(link.to);
		if (!from) sources.set(link.to, from = new Set());
		from.add(link.from);
	}

	return [...sources]
		.map(([url, from]) => {
			const page = dead.get(url)!;
			return {
				url,
				...(page.status ? { status: page.status } : {}),
				...(page.error ? { error: page.error.message } : {}),
				from: [...from].sort(),
			};
		})
		.sort((a, b) => b.from.length - a.from.length || a.url.localeCompare(b.url));
}

if (import.meta.main) {
	const seed = Deno.args[0];
	if (!seed) {
		console.error("usage: deno run -A example/recipes/broken-links.ts <url>");
		Deno.exit(1);
	}

	const report = await crawl(seed, {
		maxPages: 200,
		perHostDelay: 250,
		// images and stylesheets are links too, and an off-site target is fetched once —
		// without expanding it — so that its status is known
		extract: { assets: true },
		scope: { checkExternal: true },
	});

	const broken = brokenLinkReport(report.graph, report.pages);
	console.log(`${report.pages.length} pages crawled, ${broken.length} dead targets`);
	for (const link of broken) {
		console.log(`\n${link.status ?? link.error}  ${link.url}`);
		for (const from of link.from) console.log(`    linked from ${from}`);
	}
}
