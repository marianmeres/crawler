/**
 * One crawl = one `@marianmeres/steve` job: enqueue it, run a worker, watch it live.
 *
 * ```sh
 * DATABASE_URL=postgres://localhost/mydb \
 *     deno run -A --env-file example/recipes/steve-job.ts https://example.com
 * ```
 *
 * steve gives the crawl a durable queue entry, retry-with-backoff and a status check;
 * everything per-URL — progress, pages, bodies, the link graph — lives in the crawler's
 * own PG tables, because steve has no mid-run progress API and writes a job's `result`
 * exactly once, at the end. Hence the two questions below with two different answers.
 *
 * @module
 */

import pg from "pg";
import { Jobs } from "@marianmeres/steve";
import {
	CRAWL_JOB_TYPE,
	createCrawlJobHandler,
	startCrawlJob,
} from "@marianmeres/crawler/steve";
import type { CrawlJobResult } from "@marianmeres/crawler/steve";
import { createCrawlerPg } from "@marianmeres/crawler/pg";

/** Queue and crawler tables share it, and it is what decides who claims these jobs. */
const PREFIX = "crawlq_";

const TERMINAL = ["completed", "failed", "expired"];

if (import.meta.main) {
	const seed = Deno.args[0];
	const connectionString = Deno.env.get("DATABASE_URL");
	if (!seed || !connectionString) {
		console.error(
			"usage: DATABASE_URL=postgres://… deno run -A example/recipes/steve-job.ts <url>",
		);
		Deno.exit(1);
	}

	const db = new pg.Pool({ connectionString });
	const crawlerPg = createCrawlerPg({ db, tablePrefix: PREFIX });

	const jobs = new Jobs({
		db,
		// steve claims by status, never by type: any worker on this prefix will claim a
		// crawl job, and one without the handler registered noop-completes it — the job
		// reads `completed` and the crawl never ran. Give the crawl queue its own prefix.
		tablePrefix: PREFIX,
		jobHandlers: {
			[CRAWL_JOB_TYPE]: createCrawlJobHandler({
				db,
				pg: { tablePrefix: PREFIX },
				// hooks, events and RegExp patterns are configured here, code-side: a
				// payload is JSONB and nothing function-shaped survives it
				baseOptions: { maxDuration: 30 * 60_000, perHostDelay: 250 },
			}),
		},
		// the default of 5 minutes would expire a perfectly healthy crawl, and `expired`
		// is terminal. Measured from the first attempt's start, so it must cover them all.
		autoCleanup: { maxAllowedRunDurationMinutes: 120 },
	});

	// SIGINT belongs in the application, not in the library: the frontier, the visited set
	// and every page fetched so far are in PG, so a stopped worker leaves a run that a
	// later attempt picks up where this one left off
	Deno.addSignalListener("SIGINT", () => {
		console.log("\nstopping — the crawl keeps its place in PG");
		jobs.stop().then(() => db.end()).then(() => Deno.exit(0));
	});

	await jobs.start(1);
	const { uid } = await startCrawlJob(jobs, seed, { maxPages: 1000 });
	console.log(`job ${uid}`);

	for (;;) {
		const { job } = await jobs.find(uid); // coarse: the queue's view
		const crawl = await crawlerPg.getCrawlByJobUid(uid); // fine: live, mid-run
		const { done = 0, queued = 0, failed = 0 } = crawl?.stats ?? {};
		console.log(`${job.status}\tdone=${done} queued=${queued} failed=${failed}`);

		if (TERMINAL.includes(job.status)) {
			console.log(job.result as unknown as CrawlJobResult);
			break;
		}
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}

	await jobs.stop();
	await db.end();
}
