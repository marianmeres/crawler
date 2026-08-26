/**
 * Incremental re-crawl on PostgreSQL: crawl a site, crawl it again, list what changed.
 *
 * ```sh
 * DATABASE_URL=postgres://localhost/mydb \
 *     deno run -A --env-file example/recipes/incremental-recrawl-pg.ts https://example.com
 * ```
 *
 * The second run is the point. With `recrawl: true` the engine re-queues URLs the archive
 * already knows and re-fetches them conditionally, so an unchanged page answers `304`:
 * nothing comes over the wire, its links are re-extracted from the archived bytes, and the
 * site is still traversed in full. `listChanged` then diffs the two runs by content hash.
 *
 * The five `__crawler_*` tables are installed on first use — there is no migration to run.
 *
 * @module
 */

import pg from "pg";
import { createCrawler } from "@marianmeres/crawler";
import { createCrawlerPg } from "@marianmeres/crawler/pg";
import type { CrawlerPg } from "@marianmeres/crawler/pg";

/** One full run into PG. Returns the crawl uid — the handle to everything it wrote. */
async function crawlOnce(crawlerPg: CrawlerPg, seed: string): Promise<string> {
	const run = await crawlerPg.createCrawl({ seeds: [seed] });
	const writes: Promise<void>[] = [];

	const crawler = createCrawler({
		maxPages: 500,
		perHostDelay: 250,
		recrawl: true,
		// the durable frontier and visited set: this run outlives the process that
		// started it, and a crash resumes where it stopped
		stores: run.stores,
		events: {
			onPageDone: (res, ctx) => {
				writes.push(run.persistPage(res, ctx));
			},
			// the only way to watch a long crawl from another process
			onProgress: (stats) => {
				writes.push(run.progress(stats));
			},
		},
	});

	await run.markRunning();
	for await (const page of crawler.run(seed)) {
		console.log(page.notModified ? "304 unchanged" : page.status, page.url);
	}
	// the writes above start inside events, which the engine does not await
	await Promise.all(writes);

	const report = crawler.report()!;
	await run.markEnded({
		status: report.stoppedBy === "completed" ? "completed" : "stopped",
		stoppedBy: report.stoppedBy,
		stats: report.stats,
	});
	return run.crawl.uid;
}

if (import.meta.main) {
	const seed = Deno.args[0];
	const connectionString = Deno.env.get("DATABASE_URL");
	if (!seed || !connectionString) {
		console.error(
			"usage: DATABASE_URL=postgres://… deno run -A " +
				"example/recipes/incremental-recrawl-pg.ts <url>",
		);
		Deno.exit(1);
	}

	// the pool is the caller's: this package never opens or closes one
	const db = new pg.Pool({ connectionString });
	const crawlerPg = createCrawlerPg({ db });

	try {
		const first = await crawlOnce(crawlerPg, seed);
		const second = await crawlOnce(crawlerPg, seed);

		console.log(`\nwhat the second run saw that the first did not:`);
		for (const c of await crawlerPg.listChanged(second, { against: first })) {
			console.log(`${c.change.padEnd(8)} ${c.url}`);
		}
	} finally {
		await db.end();
	}
}
