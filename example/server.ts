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
 *   GET  /api/page?url=…            one page's archived HTML + its extracted document
 *   GET  /api/capabilities          what this server can do (browser? the caps?)
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
import { extract } from "@marianmeres/html-extract";
import { createFetcher } from "@marianmeres/page-fetcher";
import type { Fetcher } from "@marianmeres/page-fetcher";
import {
	createBrowserAdapter,
	createHttpAdapter,
	playwrightDriver,
} from "@marianmeres/page-fetcher/adapters";
import type { PlaywrightSource } from "@marianmeres/page-fetcher/adapters";
import { Jobs } from "@marianmeres/steve";
import type { Job, JobHandler } from "@marianmeres/steve";
import { createCrawler } from "@marianmeres/crawler";
import type {
	CrawlEvents,
	CrawlOptions,
	CrawlStats,
	PageContext,
	PageResult,
} from "@marianmeres/crawler";
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
	/**
	 * Tighter ceilings while browser rendering is on. A rendered page costs roughly a
	 * second and a whole browser context, where an HTTP fetch costs neither.
	 */
	js: { maxPages: 60, concurrency: 2 },
	/** Longest archived body shipped to the modal. Extraction still sees all of it. */
	bodyPreview: 1_500_000,
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

/* ---- browser rendering ----------------------------------------------------- */

/**
 * Playwright is **yours**, never this package's: neither the crawler nor page-fetcher
 * imports a browser. Absent, the UI's "Render with JS" toggle simply disables itself.
 */
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

const playwright = await loadPlaywright();

/** Extensions that are certainly not a document. Rendering a text file helps nobody. */
const NOT_HTML = /\.(txt|xml|json|css|m?js|png|jpe?g|gif|svg|webp|ico|pdf|zip|gz)($|\?)/i;

/**
 * One browser fetcher for the whole process, built on first use and disposed at
 * shutdown — a browser launch costs about a second, so per-crawl instances would be
 * absurd, and pooled contexts are what the adapter wants anyway.
 *
 * The crucial property is on the way out, not in: the adapter returns `page.content()`
 * **after** the wait strategy resolved, i.e. the serialized post-JS DOM. Those are the
 * bytes `extractLinks` sees, the bytes `contentHash` covers, and the bytes `persistBody`
 * archives — which is why the modal can show a rendered page at all.
 *
 * robots.txt never reaches this: the engine gives robots its own plain HTTP fetcher.
 */
let browserFetcher: Fetcher | undefined;

function renderingFetcher(): Fetcher {
	browserFetcher ??= createFetcher({
		// the first adapter is the default route, the rest are reachable by name
		adapters: [
			createHttpAdapter(),
			createBrowserAdapter({
				driver: playwrightDriver(playwright!),
				// the default "networkidle" is the only honest strategy here: this demo
				// does not know the target site, so it cannot name a readiness selector
				contextStrategy: "pooled",
			}),
		],
		selectAdapter: (req) => NOT_HTML.test(req.url) ? "http" : "browser",
	});
	return browserFetcher;
}

/* ---- crawl-time extraction ------------------------------------------------- */

/**
 * The crawler/scraper boundary, and it runs right here.
 *
 * `onPage`'s return value lands on `PageResult.data` and, through `./pg`, in
 * `__crawler_page.data` as JSONB — so a summary of every page is queryable without
 * touching the archive. It stays a *summary* on purpose: the full document (markdown,
 * JSON-LD, microdata) is re-extracted on demand when the modal opens, which is what
 * makes changing the extraction a page reload rather than a re-crawl.
 *
 * With browser rendering on, the string handed to `extract()` is the post-JS DOM.
 * `@marianmeres/html-extract` runs no JavaScript itself — it is the document layer over
 * whatever string the transport produced, and the transport is what decides whether
 * that string was rendered.
 */
async function summarize(res: PageResult, ctx: PageContext): Promise<unknown> {
	if (!res.ok || !(res.contentType ?? "").includes("html")) return undefined;
	try {
		// `PageResult` never carries a body: the bytes live on `ctx.fetchResult`, and
		// only for as long as this hook runs
		const html = await ctx.fetchResult?.text();
		if (!html) return undefined;
		const doc = extract(html, { url: res.finalUrl || res.url });
		const text = doc.content?.text() ?? "";
		return {
			title: doc.title ?? null,
			description: doc.metadata.description ?? null,
			author: doc.metadata.author ?? null,
			publishedAt: doc.metadata.publishedAt ?? null,
			/** Which strategy found the main content: semantic | selector | scored. */
			via: doc.content?.via ?? null,
			words: text ? text.trim().split(/\s+/).filter(Boolean).length : 0,
			linkDensity: doc.content?.linkDensity ?? null,
			jsonLd: doc.jsonLd.length,
			embeddedJson: Object.keys(doc.embeddedJson),
			microdata: doc.microdata.length,
		};
	} catch {
		// a hook that throws fails the page, and a summary is never worth that
		return undefined;
	}
}

/** Only documents are worth archiving; a PDF in the URL archive helps nobody. */
const persistHtmlOnly = (res: PageResult): boolean =>
	(res.contentType ?? "").includes("html");

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

/**
 * A payload is JSONB, so "render this one with a browser" cannot ride in it as a fetcher
 * — and an unknown key in `payload.options` is dropped with a warning, not honored. The
 * flag therefore rides on the job **type**, which `startCrawlJob` takes as an option and
 * steve routes on. Two types, two handlers, one worker.
 */
const CRAWL_JS_JOB_TYPE = "crawl-js";

const makeCrawlHandler =
	(js: boolean): JobHandler => (job: Job, signal?: AbortSignal) => {
		const ac = new AbortController();
		queueCancels.set(job.uid, ac);
		const run = createCrawlJobHandler({
			db,
			pg: { tablePrefix: PREFIX, persistBody: persistHtmlOnly },
			// hooks, events and the fetcher are configured here, code-side: none of them
			// survives `JSON.stringify` into a payload
			...(js ? { fetcher: renderingFetcher() } : {}),
			baseOptions: { signal: ac.signal, onPage: summarize },
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
	jobHandlers: {
		[CRAWL_JOB_TYPE]: makeCrawlHandler(false),
		[CRAWL_JS_JOB_TYPE]: makeCrawlHandler(true),
	},
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
	/**
	 * `normalize.trailingSlash: "strip"`. Off by default, matching the library — see the
	 * note in `./url`: `/a` and `/a/` are not interchangeable, and a directory-style site
	 * answers the slashless spelling with a 301 rather than the page.
	 */
	stripTrailingSlash: boolean;
	/** `normalize.stripWww` — folds `www.a.com` and `a.com` into one frontier key. */
	stripWww: boolean;
	respectRobots: boolean;
	persistBody: boolean;
	/** Route every document through a real browser, so the DOM is the post-JS one. */
	js: boolean;
}

/** What survived {@linkcode clamp}, plus the human-readable list of what did not. */
interface Clamped {
	options: SerializableCrawlOptions;
	seeds: string[];
	mode: "direct" | "queue";
	persistBody: boolean;
	js: boolean;
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

	let js = body.js === true;
	if (js && !playwright) {
		notes.push(
			"browser rendering is off — Playwright is not installed on this server",
		);
		js = false;
	}
	// a rendered page costs a second and a browser context; an HTTP one costs neither
	const ceiling = js
		? { maxPages: CAPS.js.maxPages, concurrency: CAPS.js.concurrency }
		: { maxPages: CAPS.maxPages, concurrency: CAPS.concurrency };

	const maxPages = cap(
		Math.max(1, Math.round(num(body.maxPages, 50))),
		ceiling.maxPages,
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
		ceiling.concurrency,
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
		// sent explicitly, defaults included: the crawl row keeps `options` verbatim, and
		// a run reopened next week should say what it was actually normalized with
		normalize: {
			trailingSlash: body.stripTrailingSlash === true ? "strip" : "keep",
			stripWww: body.stripWww === true,
		},
	};

	return {
		options,
		seeds,
		mode: body.mode === "queue" ? "queue" : "direct",
		// default ON: without an archived body the page modal has nothing to show
		persistBody: body.persistBody !== false,
		js,
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
		// the predicate arm is the size knob: keep the documents, skip the PDFs
		persistBody: req.persistBody && persistHtmlOnly,
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
		// an injected fetcher is never disposed by the engine: this one is process-wide
		// and goes at shutdown
		...(req.js ? { fetcher: renderingFetcher() } : {}),
		onPage: summarize,
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

/* ---- one page, in full ----------------------------------------------------- */

/** Decode archived bytes with whatever charset they were stored under. */
function decode(body: Uint8Array, charset?: string): string {
	try {
		return new TextDecoder(charset || "utf-8").decode(body);
	} catch {
		// an unknown label is a `TextDecoder` throw, not a reason to lose the page
		return new TextDecoder("utf-8").decode(body);
	}
}

/**
 * The archived bytes of one URL, and the document `@marianmeres/html-extract` makes of
 * them.
 *
 * There is no crawl in this lookup on purpose: the URL archive is keyed **per tenant,
 * not per crawl**, and outlives every run — it is the same stored body an incremental
 * re-crawl diffs against. The key is the *normalized* URL, which is exactly the `url`
 * field of the `PageRow` the browser is holding.
 *
 * Extraction happens here, on read, rather than at crawl time: the whole document —
 * markdown, JSON-LD, microdata — then costs nothing per row, and changing what is
 * extracted is a page reload instead of a re-crawl. `MainContent.toJSON()` materializes
 * the lazy renderings, so `JSON.stringify` is not silently lossy.
 */
async function pageDocument(url: string): Promise<Record<string, unknown>> {
	const archived = await crawlerPg.getBody(url);
	if (!archived) {
		return { html: null, bytes: 0, truncated: false, doc: null };
	}

	const html = decode(archived.body, archived.charset);
	let doc: unknown = null;
	try {
		// the whole string, not the truncated one the browser gets
		doc = extract(html, { url });
	} catch {
		doc = null;
	}

	return {
		html: html.length > CAPS.bodyPreview ? html.slice(0, CAPS.bodyPreview) : html,
		bytes: archived.body.byteLength,
		truncated: html.length > CAPS.bodyPreview,
		contentType: archived.contentType ?? null,
		charset: archived.charset ?? null,
		fetchedAt: archived.fetchedAt,
		doc,
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
			const { uid } = await startCrawlJob(
				jobs,
				request.seeds,
				// only the `false` arm goes in the payload: `true` would override the
				// factory's html-only predicate with a plain boolean
				request.persistBody ? request.options : {
					...request.options,
					persistBody: false,
				},
				{ type: request.js ? CRAWL_JS_JOB_TYPE : CRAWL_JOB_TYPE },
			);
			return json({ mode: "queue", uid, notes: request.notes });
		}
		const uid = await startDirect(request);
		return json({ mode: "direct", uid, notes: request.notes });
	}

	// what this particular server can do, so the UI can disable what it cannot
	if (path === "/api/capabilities" && req.method === "GET") {
		return json({
			browser: !!playwright,
			allowImpolite: ALLOW_IMPOLITE,
			caps: CAPS,
		});
	}

	if (path === "/api/page" && req.method === "GET") {
		const target = url.searchParams.get("url");
		if (!target) throw new HttpError(400, "?url= is required");
		return json(await pageDocument(target));
	}

	if (path === "/api/crawls" && req.method === "GET") {
		const rows = await crawlerPg.listCrawls({ limit: 10 });
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
	// this one IS ours to dispose: the engine never disposes an injected fetcher
	await browserFetcher?.[Symbol.asyncDispose]?.().catch(() => {});
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
