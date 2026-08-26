/**
 * {@linkcode createCrawlJobHandler} — the factory that turns a `@marianmeres/steve` job
 * into a crawl.
 *
 * The split it enforces is the whole point of job mode: the **payload** carries data
 * (budgets, politeness numbers, string patterns, toggles), while everything code-shaped —
 * hooks, the fetcher, RegExp patterns, the `persistBody` predicate, events — is configured
 * once, here, when the worker registers the handler. A payload that tried to carry a
 * function would not survive the JSONB column it lives in.
 *
 * @module
 */

import type { Job, JobHandler } from "@marianmeres/steve";
import type pg from "pg";
import { createCrawler } from "../crawler.ts";
import {
	type CrawlerPgOptions,
	type CrawlPersistence,
	createCrawlerPg,
	DEFAULT_TENANT_ID,
} from "../pg/crawler-pg.ts";
import type {
	Crawler,
	CrawlEvents,
	CrawlOptions,
	CrawlStats,
	Fetcher,
	FetchFn,
	Logger,
} from "../types.ts";
import type {
	CrawlJobPayload,
	CrawlJobResult,
	SerializableCrawlOptions,
} from "./types.ts";

export interface CreateCrawlJobHandlerOptions {
	/**
	 * The connection every crawl this handler runs will persist through. Job mode is
	 * always PG-backed: a retried attempt has nowhere else to resume from.
	 *
	 * Owned by the caller — the handler never opens or closes it.
	 */
	db: pg.Pool | pg.Client;
	/**
	 * `./pg` configuration, minus the three fields this factory supplies itself
	 * (`db`, `tenantId` — taken from the job — and `logger`).
	 *
	 * This is where the predicate form of `persistBody` goes; a payload can only express
	 * its boolean arm, and when it does, it wins for that job.
	 */
	pg?: Omit<CrawlerPgOptions, "db" | "tenantId" | "logger">;
	/** Convenience alias for `baseOptions.fetcher`, which it overrides. */
	fetcher?: Fetcher | FetchFn;
	/**
	 * The code-side half of a crawl's configuration: hooks, `events`, RegExp scope and
	 * normalize patterns, `robots.fetch`, a `priority` function.
	 *
	 * A payload overrides these **per top-level key** — the merge is shallow, so a payload
	 * `scope` replaces this `scope` whole rather than being merged into it.
	 *
	 * Four keys are not negotiable and are overwritten whatever this says: `stores` (the
	 * crawl's PG stores), `logger`, `fetcher` (when the factory was given one) and
	 * `collect`, which is forced off — job mode streams pages and links into PG and keeps
	 * nothing in memory.
	 */
	baseOptions?: CrawlOptions;
	/** Silent when absent. Passed on to the crawl and to `./pg`. */
	logger?: Logger;
}

/**
 * Build the steve handler that runs one crawl per job.
 *
 * Register it under the `"crawl"` job type (`CRAWL_JOB_TYPE`):
 *
 * ```ts
 * const jobs = new Jobs({
 *     db,
 *     jobHandlers: {
 *         [CRAWL_JOB_TYPE]: createCrawlJobHandler({
 *             db,
 *             baseOptions: { maxDuration: 30 * 60_000 },
 *         }),
 *     },
 * });
 * ```
 *
 * **Budget your job-mode crawls.** steve's `max_attempt_duration_ms` defaults to `0`,
 * which means no attempt timeout *and* no `AbortSignal`, so a crawl configured with none
 * of `maxDuration`, `maxPages` or `maxTotalBytes` has nothing that will ever end it. The
 * handler warns once when it sees that, and cannot do more: the budget is the consumer's.
 *
 * Retries layer: page-fetcher retries a request, the crawler retries nothing, and steve
 * retries the whole job — which is only safe because the crawl's frontier, visited set and
 * pages live in PG rather than in the attempt that died.
 *
 * **Cancellation is a hard abort, never a drain.** steve hands the handler an
 * `AbortSignal` only for a job created with `max_attempt_duration_ms > 0`, and by the time
 * it fires steve has already recorded the attempt as timed out — so the signal is
 * forwarded as `CrawlOptions.signal` (in-flight fetches cancelled, no dispatching) and the
 * attempt then *throws* instead of returning a summary of a truncated run. The crawl row
 * is left `failed` with `stopped_by = 'abort'`, which is exactly the state the retry
 * resumes from: every page already written to PG stays there.
 *
 * The returned handler is safe to invoke concurrently: everything but the once-per-handler
 * warning flags is created per job.
 */
export function createCrawlJobHandler(opts: CreateCrawlJobHandlerOptions): JobHandler {
	if (!opts?.db) {
		throw new TypeError("[crawler/steve] createCrawlJobHandler needs a `db`");
	}
	const logger = opts.logger;
	let warnedNoBudget = false;
	let warnedNoPriority = false;

	return async (job: Job, signal?: AbortSignal): Promise<CrawlJobResult> => {
		// an already-fired signal means the attempt timed out before it began: there is
		// nothing to run, and nothing may be written for it either
		signal?.throwIfAborted();

		const payload = parsePayload(job.payload, logger);
		const { persistBody, ...payloadOptions } = payload.options ?? {};

		// shallow, per top-level key, payload wins
		const merged: CrawlOptions = { ...opts.baseOptions, ...payloadOptions };

		if (
			merged.maxDuration === undefined && merged.maxPages === undefined &&
			merged.maxTotalBytes === undefined && !warnedNoBudget
		) {
			warnedNoBudget = true;
			logger?.warn(
				"[crawler/steve] this crawl has no budget (none of maxDuration, maxPages, " +
					"maxTotalBytes) — with steve's default max_attempt_duration_ms of 0 there " +
					"is no attempt timeout either, so it can run forever",
			);
		}

		// decision 13: priority is pluggable and the function cannot ride in a payload
		if (merged.strategy === "priority" && typeof merged.priority !== "function") {
			if (!warnedNoPriority) {
				warnedNoPriority = true;
				logger?.warn(
					'[crawler/steve] strategy "priority" needs a baseOptions.priority ' +
						"function, which a payload cannot carry — falling back to bfs",
				);
			}
			merged.strategy = "bfs";
		}

		const crawlerPg = createCrawlerPg({
			...opts.pg,
			db: opts.db,
			tenantId: job.tenant_id || DEFAULT_TENANT_ID,
			persistBody: persistBody ?? opts.pg?.persistBody,
			logger,
		});

		const resumed = payload.crawlUid !== undefined;
		const run = resumed
			? await crawlerPg.openCrawl(payload.crawlUid!)
			: await crawlerPg.createCrawl({
				seeds: payload.seeds,
				options: optionsSnapshot(merged, persistBody),
				jobUid: job.uid,
			});

		return await runCrawl(job, payload, run, merged, opts, resumed, signal);
	};
}

/**
 * One attempt: drive the engine over the crawl's PG stores, keeping nothing.
 *
 * The persistence writes start in *events*, which the engine does not await, so they are
 * collected and settled here — a summary written before the last page landed would report
 * a crawl that is not yet in the database.
 */
async function runCrawl(
	job: Job,
	payload: CrawlJobPayload,
	run: CrawlPersistence,
	merged: CrawlOptions,
	opts: CreateCrawlJobHandlerOptions,
	resumed: boolean,
	signal?: AbortSignal,
): Promise<CrawlJobResult> {
	const writes: Promise<void>[] = [];
	const consumer: CrawlEvents = merged.events ?? {};

	// steve's signal does not replace a `baseOptions` one — a worker that cancels its own
	// crawls has as much right to end this run as the attempt timeout does
	const cancels = [signal, merged.signal].filter((s) => s !== undefined);

	// inside the `try`: the row exists by now, so an option the engine rejects has to end
	// up marked `failed` like any other fatal error rather than leaving it `pending`
	let crawler: Crawler | undefined;

	try {
		crawler = createCrawler({
			...merged,
			signal: cancels.length > 1 ? AbortSignal.any(cancels) : cancels[0],
			stores: run.stores,
			logger: opts.logger,
			fetcher: opts.fetcher ?? merged.fetcher,
			collect: { pages: false, graph: false },
			events: {
				...consumer,
				onPageDone: (res, ctx) => {
					writes.push(run.persistPage(res, ctx));
					consumer.onPageDone?.(res, ctx);
				},
				onProgress: (stats) => {
					writes.push(run.progress(stats));
					consumer.onProgress?.(stats);
				},
			},
		});

		await run.markRunning();

		// drained for its side effects: the pages are already streaming into PG
		for await (const _page of crawler.run(payload.seeds)) {
			// deliberately empty
		}
		await Promise.all(writes);

		const report = crawler.report()!;

		// a run the attempt timeout cut short is not a result: steve has already recorded
		// the timeout, so reporting a summary here would freeze a half-crawl into a
		// terminal row and the retry would have nothing left to resume
		if (report.stoppedBy === "abort" && signal?.aborted) signal.throwIfAborted();

		await run.markEnded({
			status: report.stoppedBy === "completed" ? "completed" : "stopped",
			stoppedBy: report.stoppedBy,
			stats: report.stats,
		});

		return {
			crawlUid: run.crawl.uid,
			stoppedBy: report.stoppedBy,
			stats: summaryStats(report.stats),
			attempt: job.attempts,
			resumed,
		};
	} catch (error) {
		await Promise.allSettled(writes);
		await run.markEnded({
			status: "failed",
			// what ended it, for the human reading the row after the retry
			...(signal?.aborted ? { stoppedBy: "abort" as const } : {}),
			error: describeError(error),
		})
			.catch((e) =>
				opts.logger?.warn(`[crawler/steve] marking the crawl failed: ${e}`)
			);
		throw error;
	} finally {
		// only what this attempt built: the engine-owned fetcher, never an injected one
		await crawler?.[Symbol.asyncDispose]();
	}
}

// -----------------------------------------------------------------------------------
// payload validation
// -----------------------------------------------------------------------------------

type OptionKind = "string" | "number" | "boolean" | "object";

/**
 * The runtime type of every option a payload may carry.
 *
 * Keyed by `Required<SerializableCrawlOptions>`, so a new serializable option that nobody
 * lists here fails `deno check` — the same drift guard `tests/steve-types.test.ts` puts on
 * the type itself, applied to the validator that has to agree with it.
 */
const OPTION_KINDS: Record<keyof Required<SerializableCrawlOptions>, OptionKind> = {
	userAgent: "string",
	concurrency: "number",
	perHostConcurrency: "number",
	perHostDelay: "number",
	strategy: "string",
	maxQueued: "number",
	maxDepth: "number",
	maxPages: "number",
	maxDuration: "number",
	maxTotalBytes: "number",
	scope: "object",
	normalize: "object",
	extract: "object",
	robots: "object",
	traps: "object",
	followCanonical: "boolean",
	recrawl: "boolean",
	allowPrivateHosts: "boolean",
	progressInterval: "number",
	persistBody: "boolean",
};

/**
 * Read a JSONB payload as a {@linkcode CrawlJobPayload}.
 *
 * Unknown keys are a warning and nothing else — a newer enqueuer writing a key this worker
 * has never heard of should not fail the job. A *known* key of the wrong type is fatal:
 * there is no reading of `maxPages: "lots"` that is not a mistake, and letting it through
 * would produce a crawl that silently ignores the budget it was given.
 */
function parsePayload(raw: unknown, logger?: Logger): CrawlJobPayload {
	if (!isPlainObject(raw)) {
		throw new TypeError(
			`[crawler/steve] payload must be an object (got ${describe(raw)})`,
		);
	}

	const { seeds, options, crawlUid, ...rest } = raw;
	warnUnknown(logger, "payload", Object.keys(rest));

	if (
		!Array.isArray(seeds) || seeds.length === 0 ||
		!seeds.every((seed) => typeof seed === "string" && seed.trim() !== "")
	) {
		throw new TypeError(
			"[crawler/steve] payload.seeds must be a non-empty array of non-empty strings",
		);
	}
	if (crawlUid !== undefined && typeof crawlUid !== "string") {
		throw new TypeError(
			`[crawler/steve] payload.crawlUid must be a string (got ${
				describe(crawlUid)
			})`,
		);
	}

	return {
		seeds: seeds as string[],
		options: parseOptions(options, logger),
		...(crawlUid === undefined ? {} : { crawlUid: crawlUid as string }),
	};
}

function parseOptions(raw: unknown, logger?: Logger): SerializableCrawlOptions {
	if (raw === undefined || raw === null) return {};
	if (!isPlainObject(raw)) {
		throw new TypeError(
			`[crawler/steve] payload.options must be an object (got ${describe(raw)})`,
		);
	}

	const parsed: Record<string, unknown> = {};
	const unknown: string[] = [];

	for (const [key, value] of Object.entries(raw)) {
		if (value === undefined) continue;
		const kind = OPTION_KINDS[key as keyof SerializableCrawlOptions];
		if (kind === undefined) {
			unknown.push(key);
			continue;
		}
		if (!isKind(value, kind)) {
			throw new TypeError(
				`[crawler/steve] payload.options.${key} must be a ${kind} ` +
					`(got ${describe(value)})`,
			);
		}
		parsed[key] = value;
	}

	warnUnknown(logger, "payload.options", unknown);
	return parsed as SerializableCrawlOptions;
}

function warnUnknown(logger: Logger | undefined, where: string, keys: string[]): void {
	if (keys.length) {
		logger?.warn(
			`[crawler/steve] ignoring unknown ${where} keys: ${keys.join(", ")}`,
		);
	}
}

function isKind(value: unknown, kind: OptionKind): boolean {
	switch (kind) {
		case "object":
			return isPlainObject(value);
		case "string":
			return typeof value === "string";
		case "number":
			return typeof value === "number";
		case "boolean":
			return typeof value === "boolean";
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
	if (value === null) return "null";
	return Array.isArray(value) ? "array" : typeof value;
}

// -----------------------------------------------------------------------------------

/**
 * What the crawl row records about how it was configured: the merged serializable subset,
 * payload included. Functions and RegExps from `baseOptions` are unrepresentable in JSONB
 * and do not survive — the snapshot answers "which budgets and toggles ran", not "rebuild
 * this crawl from here".
 */
function optionsSnapshot(
	merged: CrawlOptions,
	persistBody: boolean | undefined,
): Record<string, unknown> {
	const snapshot: Record<string, unknown> = {};
	for (const key of Object.keys(OPTION_KINDS)) {
		const value = (merged as Record<string, unknown>)[key];
		if (value !== undefined) snapshot[key] = value;
	}
	if (persistBody !== undefined) snapshot.persistBody = persistBody;
	return snapshot;
}

/** Decision 3: `byHost` is unbounded on a wide crawl, so it never reaches the job row. */
function summaryStats(stats: CrawlStats): CrawlJobResult["stats"] {
	const { byHost: _byHost, ...rest } = stats;
	return rest;
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
