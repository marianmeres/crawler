/**
 * `startCrawlJob` — the enqueue helper, against a `Jobs` double.
 *
 * No database and no queue: what is under test is what reaches `jobs.create` and what
 * never gets there. The double records every invocation, which is the only way to assert
 * the important half — that a bad seed list is refused *before* the insert, rather than
 * queued to fail three times on the worker.
 *
 * @module
 */

import { assertEquals, assertStrictEquals, assertThrows } from "@std/assert";
import type { Job, JobCreateOptions, Jobs } from "@marianmeres/steve";
import { CRAWL_JOB_TYPE, startCrawlJob } from "../src/steve/mod.ts";

interface Created {
	type: string;
	payload: Record<string, unknown>;
	options?: JobCreateOptions;
}

/** A `Jobs` whose `create` records and hands back a uid — the only method reached. */
function jobsDouble(): { jobs: Jobs; created: Created[] } {
	const created: Created[] = [];
	const jobs = {
		create(
			type: string,
			payload: Record<string, unknown>,
			options?: JobCreateOptions,
		): Promise<Job> {
			created.push({ type, payload, options });
			return Promise.resolve({ uid: "job-uid-1" } as Job);
		},
	} as unknown as Jobs;
	return { jobs, created };
}

Deno.test("a bad seed list throws before anything is enqueued", () => {
	const { jobs, created } = jobsDouble();

	const bad: (string | string[])[] = [
		[],
		"",
		"   ",
		[""],
		[`https://example.com`, "  "],
		null as unknown as string,
		undefined as unknown as string,
		42 as unknown as string,
		[42] as unknown as string[],
		{ url: "https://example.com" } as unknown as string,
	];

	for (const seeds of bad) {
		assertThrows(
			() => startCrawlJob(jobs, seeds),
			TypeError,
			"startCrawlJob needs a non-empty seed URL",
		);
	}

	assertEquals(created.length, 0);
});

Deno.test("a valid call enqueues exactly one crawl job", async () => {
	const { jobs, created } = jobsDouble();

	const { uid } = await startCrawlJob(jobs, "https://example.com", { maxPages: 5 });

	assertEquals(uid, "job-uid-1");
	assertEquals(created.length, 1);
	assertEquals(created[0].type, CRAWL_JOB_TYPE);
	// a single seed is normalized to the list the payload contract promises
	assertEquals(created[0].payload, {
		seeds: ["https://example.com"],
		options: { maxPages: 5 },
	});
});

Deno.test("the payload survives the JSONB column it is headed for", async () => {
	const { jobs, created } = jobsDouble();

	await startCrawlJob(
		jobs,
		["https://example.com", "https://example.com/deep"],
		{
			maxPages: 500,
			maxDuration: 60_000,
			perHostDelay: 250,
			userAgent: "test-agent",
			persistBody: true,
			scope: { subdomains: "same-site", exclude: ["/search"] },
			normalize: { stripParams: ["utm_source"] },
		},
		{ crawlUid: "crawl-uid-1" },
	);

	const { payload } = created[0];
	assertEquals(JSON.parse(JSON.stringify(payload)), payload);
});

Deno.test("steve's own options pass through verbatim, the crawl's do not", async () => {
	const { jobs, created } = jobsDouble();
	const runAt = new Date("2026-09-01T10:00:00.000Z");

	await startCrawlJob(jobs, "https://example.com", undefined, {
		type: "crawl-nightly",
		tenant_id: "acme",
		run_at: runAt,
		max_attempts: 5,
		max_attempt_duration_ms: 30 * 60_000,
		backoff_strategy: "none",
		crawlUid: "crawl-uid-1",
	});

	assertEquals(created.length, 1);
	assertEquals(created[0].type, "crawl-nightly");
	assertEquals(created[0].options, {
		tenant_id: "acme",
		run_at: runAt,
		max_attempts: 5,
		max_attempt_duration_ms: 30 * 60_000,
		backoff_strategy: "none",
	});
	assertStrictEquals(created[0].options?.run_at, runAt);

	// `type` and `crawlUid` are the crawler's, and steve must not see them as job options
	assertEquals(created[0].payload, {
		seeds: ["https://example.com"],
		crawlUid: "crawl-uid-1",
	});
});

Deno.test("no options means no keys — an absent one is not an undefined one", async () => {
	const { jobs, created } = jobsDouble();

	await startCrawlJob(jobs, ["https://example.com"]);

	assertEquals(Object.keys(created[0].payload), ["seeds"]);
	assertEquals(created[0].options, {});
});
