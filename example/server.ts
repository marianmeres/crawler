/**
 * The example app's server: static files, and a small HTTP API that starts a crawl,
 * clamps what it was asked for, and answers the browser's polling.
 *
 * Why a server at all — a crawl is not something a browser can run. Cross-origin
 * `fetch` is blocked by CORS, `robots.txt` would be unreadable, and a crawl is a
 * long-lived background job that outlives a page. So the browser holds the controls
 * and the crawl runs here, in Deno, against PostgreSQL.
 *
 * Two ways to run one, switchable in the UI, because the package offers both:
 *
 *   direct — this process owns the crawl. `createCrawler` streams pages, the `./pg`
 *            handle persists each one and publishes throttled progress. Simple, and it
 *            dies with the process.
 *   queue  — the crawl is enqueued as ONE `@marianmeres/steve` job and an in-process
 *            worker runs it. Durable, retried, and it survives a restart.
 *
 * The polling half is identical either way, and that is the point: progress never comes
 * from the runner, it comes from `__crawler_crawl.stats` and the page/link tables. steve
 * has no mid-run progress API, so job mode would have nothing to show otherwise.
 *
 * Routes:
 *
 *   GET  /                          the app (index.html + bundle + the two stylesheets)
 *   POST /api/crawl                 start one; answers with the handle to poll
 *   GET  /api/crawl/:mode/:uid      the poll — stats, then the new pages and links
 *   POST /api/crawl/:mode/:uid/stop ask a running crawl to wind down
 *   GET  /api/crawl/:mode/:uid/broken   the broken-link report, once it has ended
 *   GET  /api/crawls                recent runs, so a reload can pick one back up
 *
 * ⚠️ This crawls whatever URL it is handed. Every budget below is a *server-side*
 * ceiling for exactly that reason — see CAPS, and `clamp()`, which reports what it took
 * away rather than silently obeying a number the browser made up.
 *
 * Run with: `deno task example` (then open http://127.0.0.1:8000).
 */

import pg from "pg";
import { extname, fromFileUrl, join, normalize } from "@std/path";
import { Jobs } from "@marianmeres/steve";
import type { Job, JobHandler } from "@marianmeres/steve";
import { createCrawler } from "@marianmeres/crawler";
import type { CrawlEvents, CrawlOptions, CrawlStats } from "@marianmeres/crawler";
import { createCrawlerPg } from "@marianmeres/crawler/pg";
import type { CrawlPersistence, CrawlRow } from "@marianmeres/crawler/pg";
import {
	CRAWL_JOB_TYPE,
	createCrawlJobHandler,
	startCrawlJob,
} from "@marianmeres/crawler/steve";
import type { SerializableCrawlOptions } from "@marianmeres/crawler/steve";

/* ---- config ---------------------------------------------------------------- */

const PORT = Number(Deno.env.get("PORT") ?? 8000);
/** `127.0.0.1` by default; a deployment sets `EXAMPLE_HOST=0.0.0.0` deliberately. */
const HOSTNAME = Deno.env.get("EXAMPLE_HOST") ?? "127.0.0.1";
const STATIC_ROOT = fromFileUrl(new URL("./", import.meta.url));

/** Crawler tables and steve's queue tables share it — see the note on `jobs` below. */
const PREFIX = "example_";

/**
 * The hard ceilings. A browser can ask for anything; this is what it gets, and
 * {@linkcode clamp} tells it which of its numbers were overruled.
 */
const CAPS = {
	seeds: 10,
	maxPages: 300,
	maxDepth: 6,
	maxDuration: 5 * 60_000,
	maxTotalBytes: 64 * 1024 * 1024,
	concurrency: 8,
	/** A floor, not a cap: nobody gets to hammer a stranger's site from this box. */
	minPerHostDelay: 100,
	/** Concurrent `direct` crawls. Queue mode has its own limit: one worker. */
	liveDirect: 2,
	/** Rows returned per poll, per table. */
	pollRows: 250,
} as const;

/**
 * Ignoring robots.txt is a legitimate library feature and a terrible thing to hand an
 * anonymous visitor, so the toggle is real but the server refuses it unless the operator
 * opted in.
 */
const ALLOW_IMPOLITE = Deno.env.get("EXAMPLE_ALLOW_IMPOLITE") === "1";

const HTML = "text/html; charset=utf-8";
const MIME: Record<string, string> = {
	".html": HTML,
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
};

/* ---- database -------------------------------------------------------------- */

const db = new pg.Pool({
	host: Deno.env.get("EXAMPLE_PG_HOST") ?? "localhost",
	database: Deno.env.get("EXAMPLE_PG_DATABASE") ?? "example_crawler",
	user: Deno.env.get("EXAMPLE_PG_USER") || undefined,
	password: Deno.env.get("EXAMPLE_PG_PASSWORD") || undefined,
	port: Number(Deno.env.get("EXAMPLE_PG_PORT") ?? 5432),
	max: 10,
});

const crawlerPg = createCrawlerPg({ db, tablePrefix: PREFIX });

/* ---- the queue ------------------------------------------------------------- */

/**
 * Per-job cancellation, which steve does not offer: the handler is built *per job* so
 * each crawl gets an `AbortSignal` of its own on `baseOptions`.
 *
 * It has to arrive that way rather than as steve's own signal. steve's means "this
 * attempt timed out", and the handler rethrows it so the job retries; a crawl aborted
 * through `baseOptions.signal` ends `stopped`, which is what a person clicking Stop
 * means.
 */
const queueCancels = new Map<string, AbortController>();

const crawlHandler: JobHandler = (job: Job, signal?: AbortSignal) => {
	const ac = new AbortController();
	queueCancels.set(job.uid, ac);
	const run = createCrawlJobHandler({
		db,
		pg: { tablePrefix: PREFIX },
		baseOptions: { signal: ac.signal },
	});
	return Promise.resolve(run(job, signal))
		.finally(() => queueCancels.delete(job.uid));
};

const jobs = new Jobs({
	db,
	// steve claims by status, never by type: any worker on this prefix would claim these
	// jobs, and one without the crawl handler noop-completes them — the job reads
	// `completed` and the crawl never ran. One prefix, one worker, no ambiguity here.
	tablePrefix: PREFIX,
	jobHandlers: { [CRAWL_JOB_TYPE]: crawlHandler },
	// the default of 5 minutes would expire a healthy crawl, and `expired` is terminal.
	// Measured from the first attempt's start, so it must cover every attempt plus backoff.
	autoCleanup: { maxAllowedRunDurationMinutes: 60 },
});

/* ---- options: what the browser asks for, and what it actually gets ---------- */

/** The knobs this demo exposes. Everything else stays at the library's defaults. */
interface Requested {
	seeds: string[];
	mode: "direct" | "queue";
	maxDepth: number;
	maxPages: number;
	maxDuration: number;
	concurrency: number;
	perHostDelay: number;
	subdomains: "same-host" | "same-site" | "any";
	allowExternal: boolean;
	checkExternal: boolean;
	assets: boolean;
	sitemaps: boolean;
	respectRobots: boolean;
	persistBody: boolean;
}

/** What survived {@linkcode clamp}, plus the human-readable list of what did not. */
interface Clamped {
	options: SerializableCrawlOptions;
	seeds: string[];
	mode: "direct" | "queue";
	persistBody: boolean;
	notes: string[];
}

const num = (v: unknown, fallback: number): number => {
	const n = Number(v);
	return Number.isFinite(n) ? n : fallback;
};

/**
 * Force the request inside the ceilings, collecting a note for every number that had to
 * move. The notes are shown in the UI: a demo that quietly ignores what you typed
 * teaches the wrong thing about the library's budgets.
 */
function clamp(body: Partial<Requested>): Clamped {
	const notes: string[] = [];

	const raw = Array.isArray(body.seeds) ? body.seeds : [];
	const seeds = raw
		.map((s) => String(s ?? "").trim())
		.filter(Boolean)
		.slice(0, CAPS.seeds);
	if (raw.length > seeds.length) {
		notes.push(`only the first ${CAPS.seeds} seeds are accepted`);
	}
	if (!seeds.length) throw new HttpError(400, "Give me at least one seed URL.");
	for (const seed of seeds) {
		let url: URL;
		try {
			url = new URL(seed);
		} catch {
			throw new HttpError(400, `Not a URL: ${seed}`);
		}
		if (url.protocol !== "http:" && url.protocol !== "https:") {
			throw new HttpError(400, `Only http(s) seeds here: ${seed}`);
		}
	}

	const cap = (value: number, max: number, label: string): number => {
		if (value > max) notes.push(`${label} capped to ${max}`);
		return Math.min(value, max);
	};

	const maxPages = cap(
		Math.max(1, Math.round(num(body.maxPages, 50))),
		CAPS.maxPages,
		"maxPages",
	);
	const maxDepth = cap(
		Math.max(0, Math.round(num(body.maxDepth, 2))),
		CAPS.maxDepth,
		"maxDepth",
	);
	const maxDuration = cap(
		Math.max(5_000, num(body.maxDuration, 120_000)),
		CAPS.maxDuration,
		"maxDuration",
	);
	const concurrency = cap(
		Math.max(1, Math.round(num(body.concurrency, 4))),
		CAPS.concurrency,
		"concurrency",
	);

	let perHostDelay = Math.max(0, Math.round(num(body.perHostDelay, 250)));
	if (perHostDelay < CAPS.minPerHostDelay) {
		notes.push(
			`perHostDelay raised to ${CAPS.minPerHostDelay} ms — politeness floor`,
		);
		perHostDelay = CAPS.minPerHostDelay;
	}

	let respect = body.respectRobots !== false;
	if (!respect && !ALLOW_IMPOLITE) {
		notes.push(
			"robots.txt stays on — set EXAMPLE_ALLOW_IMPOLITE=1 to allow otherwise",
		);
		respect = true;
	}

	const options: SerializableCrawlOptions = {
		maxPages,
		maxDepth,
		maxDuration,
		maxTotalBytes: CAPS.maxTotalBytes,
		concurrency,
		perHostDelay,
		scope: {
			subdomains: body.subdomains ?? "same-host",
			allowExternal: body.allowExternal === true,
			checkExternal: body.checkExternal === true,
		},
		extract: { assets: body.assets === true },
		robots: { respect, sitemaps: body.sitemaps === true },
	};

	return {
		options,
		seeds,
		mode: body.mode === "queue" ? "queue" : "direct",
		persistBody: body.persistBody === true,
		notes,
	};
}

/* ---- direct mode ----------------------------------------------------------- */

/** Live `direct` crawls, so Stop has something to call and the pool has a size. */
const live = new Map<string, { stop: (reason: string) => Promise<void> }>();

/**
 * Start a crawl in this process and return as soon as the row exists — the browser polls
 * for the rest.
 *
 * This is `examples/`-style consumer code with one twist: the persistence writes start in
 * *events*, which the engine does not await, so they are collected and settled before the
 * run is marked ended. A summary written before the last page landed would describe a
 * crawl that is not yet in the database.
 */
async function startDirect(req: Clamped): Promise<string> {
	if (live.size >= CAPS.liveDirect) {
		throw new HttpError(
			429,
			`${CAPS.liveDirect} direct crawls are already running — wait, or switch to ` +
				`queue mode, where yours will wait its turn instead.`,
		);
	}

	const runner = createCrawlerPg({
		db,
		tablePrefix: PREFIX,
		persistBody: req.persistBody,
	});
	const run: CrawlPersistence = await runner.createCrawl({
		seeds: req.seeds,
		options: req.options as Record<string, unknown>,
	});
	const uid = run.crawl.uid;

	const writes: Promise<unknown>[] = [];
	const events: CrawlEvents = {
		onPageDone: (res, ctx) => void writes.push(run.persistPage(res, ctx)),
		onProgress: (stats: CrawlStats) => void writes.push(run.progress(stats)),
	};

	const crawler = createCrawler({
		...(req.options as CrawlOptions),
		stores: run.stores,
		collect: { pages: false, graph: false },
		events,
	});

	live.set(uid, { stop: (reason) => crawler.stop(reason) });

	// deliberately not awaited: the response is the handle, the crawl is the background
	(async () => {
		try {
			await run.markRunning();
			// drained for its side effects — the pages are already streaming into PG
			for await (const _page of crawler.run(req.seeds)) {
				// deliberately empty
			}
			await Promise.all(writes);
			const report = crawler.report()!;
			await run.markEnded({
				status: report.stoppedBy === "completed" ? "completed" : "stopped",
				stoppedBy: report.stoppedBy,
				stats: report.stats,
			});
		} catch (error) {
			await Promise.allSettled(writes);
			await run.markEnded({ status: "failed", error: String(error) })
				.catch(() => {});
		} finally {
			live.delete(uid);
			await crawler[Symbol.asyncDispose]();
		}
	})();

	return uid;
}

/* ---- the poll -------------------------------------------------------------- */

/**
 * One handle, two shapes — the asymmetry the package documents, made concrete.
 *
 * `direct` polls the crawl by its own uid. `queue` polls by the *job* uid, because in
 * job mode the crawl row does not exist until a worker picks the job up: until then the
 * only true answer is "pending, in the queue".
 */
type Mode = "direct" | "queue";

async function snapshot(
	mode: Mode,
	uid: string,
	cursors: { pages: number; links: number },
): Promise<Record<string, unknown>> {
	let crawl: CrawlRow | null;
	let job: { status: string; attempts: number; error: string | null } | null = null;

	if (mode === "queue") {
		// `withAttempts` because a job row carries no error — the attempt log does, and
		// "why did it fail" is the whole reason to look
		const found = await jobs.find(uid, true).catch(() => null);
		if (!found?.job) throw new HttpError(404, `No such job: ${uid}`);
		job = {
			status: found.job.status,
			attempts: found.job.attempts,
			error: found.attempts?.findLast((a) => a.error_message)?.error_message ??
				null,
		};
		crawl = await crawlerPg.getCrawlByJobUid(uid);
	} else {
		crawl = await crawlerPg.getCrawl(uid);
		if (!crawl) throw new HttpError(404, `No such crawl: ${uid}`);
	}

	// nothing to list until a crawl row exists (queue mode, still pending)
	const [pages, links] = crawl
		? await Promise.all([
			crawlerPg.listPages(crawl.uid, {
				limit: CAPS.pollRows,
				offset: cursors.pages,
			}),
			crawlerPg.listLinks(crawl.uid, {
				limit: CAPS.pollRows,
				offset: cursors.links,
			}),
		])
		: [[], []];

	const terminal = mode === "queue"
		? ["completed", "failed", "expired"].includes(job!.status)
		: !!crawl && ["completed", "failed", "stopped"].includes(crawl.status);

	return {
		mode,
		uid,
		job,
		crawl: crawl && {
			uid: crawl.uid,
			seeds: crawl.seeds,
			status: crawl.status,
			stats: crawl.stats,
			// the UI's progress bar needs the budget it is measuring against, and a
			// reopened run has to get it from here — the form may have moved on
			options: crawl.options,
			stoppedBy: crawl.stoppedBy,
			error: crawl.error,
			startedAt: crawl.startedAt,
			endedAt: crawl.endedAt,
		},
		pages,
		links,
		// the client keeps polling while either is true: a crawl that just ended can still
		// have rows the last poll did not reach
		terminal,
		more: pages.length === CAPS.pollRows || links.length === CAPS.pollRows,
		stoppable: mode === "queue" ? queueCancels.has(uid) : live.has(uid),
	};
}

/* ---- routes ---------------------------------------------------------------- */

class HttpError extends Error {
	constructor(readonly status: number, message: string) {
		super(message);
	}
}

const json = (data: unknown, status = 200): Response =>
	new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": MIME[".json"] },
	});

async function api(req: Request, url: URL): Promise<Response> {
	const path = url.pathname;

	if (path === "/api/crawl" && req.method === "POST") {
		const body = await req.json().catch(() => ({}));
		const request = clamp(body as Partial<Requested>);

		if (request.mode === "queue") {
			const { uid } = await startCrawlJob(jobs, request.seeds, {
				...request.options,
				persistBody: request.persistBody,
			});
			return json({ mode: "queue", uid, notes: request.notes });
		}
		const uid = await startDirect(request);
		return json({ mode: "direct", uid, notes: request.notes });
	}

	if (path === "/api/crawls" && req.method === "GET") {
		const rows = await crawlerPg.listCrawls({ limit: 20 });
		return json({
			crawls: rows.map((c) => ({
				uid: c.uid,
				jobUid: c.jobUid,
				seeds: c.seeds,
				status: c.status,
				stoppedBy: c.stoppedBy,
				stats: c.stats,
				createdAt: c.createdAt,
			})),
		});
	}

	// /api/crawl/:mode/:uid[/stop|/broken]
	const parts = path.split("/").filter(Boolean); // ["api","crawl",mode,uid,tail?]
	if (parts[0] === "api" && parts[1] === "crawl" && parts.length >= 4) {
		const mode: Mode = parts[2] === "queue" ? "queue" : "direct";
		const uid = parts[3];
		const tail = parts[4];

		if (!tail && req.method === "GET") {
			return json(
				await snapshot(mode, uid, {
					pages: Math.max(0, num(url.searchParams.get("pages"), 0)),
					links: Math.max(0, num(url.searchParams.get("links"), 0)),
				}),
			);
		}

		if (tail === "stop" && req.method === "POST") {
			if (mode === "queue") {
				const ac = queueCancels.get(uid);
				ac?.abort(new Error("stopped from the example UI"));
				return json({ stopped: !!ac });
			}
			const handle = live.get(uid);
			await handle?.stop("stopped from the example UI");
			return json({ stopped: !!handle });
		}

		if (tail === "broken" && req.method === "GET") {
			// the report is per crawl, so job mode has to resolve its crawl row first
			const crawl = mode === "queue"
				? await crawlerPg.getCrawlByJobUid(uid)
				: await crawlerPg.getCrawl(uid);
			if (!crawl) throw new HttpError(404, `Nothing to report on: ${uid}`);
			return json({ broken: await crawlerPg.brokenLinks(crawl.uid) });
		}
	}

	throw new HttpError(404, `No route: ${req.method} ${path}`);
}

/* ---- static ---------------------------------------------------------------- */

async function serveStatic(url: URL): Promise<Response> {
	const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
	// normalize first, then confirm the result is still inside the example directory
	const file = join(STATIC_ROOT, normalize(rel));
	if (!file.startsWith(STATIC_ROOT)) return new Response("Nope", { status: 403 });
	try {
		const body = await Deno.readFile(file);
		return new Response(body, {
			headers: {
				"content-type": MIME[extname(file)] ?? "application/octet-stream",
				"cache-control": "no-cache",
			},
		});
	} catch {
		return new Response("Not found", { status: 404 });
	}
}

/* ---- boot ------------------------------------------------------------------ */

await jobs.start(1);

/**
 * BOTH signals, not just SIGINT. steve installs its own SIGTERM handler that stops the
 * job processors and deliberately does *not* exit ("that is the consumer's
 * responsibility") — so without this the process survives a `kill`/`docker stop` with a
 * dead queue: HTTP keeps accepting crawls and nothing ever claims them.
 *
 * A `direct` crawl dies here. A `queued` one does not: its frontier, visited set and
 * pages are in PG, so the next worker picks the run up where this one left off.
 */
let shuttingDown = false;
const shutdown = async () => {
	if (shuttingDown) return;
	shuttingDown = true;
	console.log("\nstopping — a queued crawl keeps its place in PG");
	await jobs.stop().catch(() => {});
	await db.end().catch(() => {});
	Deno.exit(0);
};

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	Deno.addSignalListener(signal, () => void shutdown());
}

Deno.serve({ port: PORT, hostname: HOSTNAME }, async (req) => {
	const url = new URL(req.url);
	try {
		if (url.pathname.startsWith("/api/")) return await api(req, url);
		return await serveStatic(url);
	} catch (error) {
		const status = error instanceof HttpError ? error.status : 500;
		if (status === 500) console.error(error);
		return json({ error: (error as Error).message ?? String(error) }, status);
	}
});
