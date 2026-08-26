/**
 * The observation surface: the seven {@linkcode CrawlEvents}, their payloads, their
 * order, and the two guarantees that make them safe to attach anything to — a throwing
 * handler cannot change the crawl's outcome, and `onProgress` is throttled.
 *
 * Every crawl here runs `robots.respect: false` (the robots gate has its own suite) and
 * against a fake transport, so the event log is deterministic.
 *
 * @module
 */

import { assert, assertEquals, assertFalse, assertGreaterOrEqual } from "@std/assert";
import { crawl, createCrawler } from "../src/crawler.ts";
import type {
	CrawlEvents,
	CrawlReport,
	CrawlStats,
	FrontierItem,
	LinkRecord,
	PageContext,
	PageResult,
} from "../src/types.ts";
import { type MiniSite, recordingLogger, SITE, siteFetch } from "./_helpers.ts";

/**
 * Three pages that between them produce all seven events: `/ok` succeeds, `/boom` fails
 * terminally (→ `onPageError`), and the off-site link is skipped (→ `onLinkSkipped`).
 */
const EVENTS_SITE: MiniSite = {
	[`${SITE}/`]: {
		html: `<title>Home</title>
			<a href="/ok">ok</a>
			<a href="/boom">boom</a>
			<a href="http://ext.test/x">external</a>`,
	},
	[`${SITE}/ok`]: { html: `<title>OK</title>` },
	[`${SITE}/boom`]: { error: { kind: "network", message: "scripted failure" } },
};

/** One entry per fired event, in fire order. */
interface Fired {
	name: keyof CrawlEvents;
	// deno-lint-ignore no-explicit-any
	args: any[];
}

/** Attach a recorder to all seven events and return the log it fills. */
function recordEvents(): { log: Fired[]; events: CrawlEvents; names(): string[] } {
	const log: Fired[] = [];
	// deno-lint-ignore no-explicit-any
	const on = (name: keyof CrawlEvents) => (...args: any[]) => {
		log.push({ name, args });
	};

	return {
		log,
		events: {
			onStart: on("onStart"),
			onPageStart: on("onPageStart"),
			onPageDone: on("onPageDone"),
			onPageError: on("onPageError"),
			onLinkSkipped: on("onLinkSkipped"),
			onProgress: on("onProgress"),
			onEnd: on("onEnd"),
		},
		names: () => log.map((entry) => entry.name),
	};
}

/** Every `Fired` of one kind, with its first argument typed. */
function argsOf<T>(log: Fired[], name: keyof CrawlEvents): T[] {
	return log.filter((entry) => entry.name === name).map((entry) => entry.args[0] as T);
}

// -----------------------------------------------------------------------------------
// (a) every event fires, with the documented payload, in a legal order
// -----------------------------------------------------------------------------------

Deno.test("events — one crawl fires all seven, with the documented payloads", async () => {
	const rec = recordEvents();
	const crawler = createCrawler({
		fetcher: siteFetch(EVENTS_SITE),
		robots: { respect: false },
		collect: { pages: true },
		events: rec.events,
	});
	for await (const _page of crawler.run(`${SITE}/`)) {
		// drained for the events
	}

	// --- all seven, none missing ---
	for (
		const name of [
			"onStart",
			"onPageStart",
			"onPageDone",
			"onPageError",
			"onLinkSkipped",
			"onProgress",
			"onEnd",
		] as const
	) {
		assert(rec.names().includes(name), `${name} never fired`);
	}

	// --- onStart: the crawl id, the normalized seeds, the RESOLVED options ---
	const starts = argsOf<
		// deno-lint-ignore no-explicit-any
		{ crawlId: string; seeds: string[]; options: any }
	>(rec.log, "onStart");
	assertEquals(starts.length, 1);
	assertEquals(starts[0].crawlId, crawler.crawlId);
	assertEquals(starts[0].seeds, [`${SITE}/`]);
	// post-defaults: nothing here was passed in, and none of it is `undefined`
	assertEquals(starts[0].options.concurrency, 5);
	assertEquals(starts[0].options.maxPages, Infinity);
	assertEquals(starts[0].options.progressInterval, 500);

	// --- onPageStart: the frontier item, one per fetched page ---
	const started = argsOf<FrontierItem>(rec.log, "onPageStart");
	assertEquals(
		started.map((item) => item.url).sort(),
		[`${SITE}/`, `${SITE}/boom`, `${SITE}/ok`],
	);
	const seed = started.find((item) => item.url === `${SITE}/`)!;
	assertEquals(seed.host, "site.test");
	assertEquals(seed.depth, 0);
	assertEquals(seed.discoveredVia, "seed");

	// --- onPageDone: the result plus the context that gives body access ---
	const done = rec.log.filter((entry) => entry.name === "onPageDone");
	assertEquals(done.length, 3);
	for (const entry of done) {
		const res = entry.args[0] as PageResult;
		const ctx = entry.args[1] as PageContext;
		assertEquals(ctx.crawlId, crawler.crawlId);
		assertEquals(ctx.requestId, res.requestId);
		assertEquals(ctx.item.url, res.url);
		assert(typeof ctx.stats.done === "number");
	}
	const okDone = done.find((e) => (e.args[0] as PageResult).url === `${SITE}/ok`)!;
	assertEquals((okDone.args[0] as PageResult).status, 200);
	assert((okDone.args[1] as PageContext).fetchResult !== undefined);

	// --- onPageError: the ORIGINAL throwable, and its item ---
	const errors = rec.log.filter((entry) => entry.name === "onPageError");
	assertEquals(errors.length, 1);
	assert(errors[0].args[0] instanceof Error);
	assertEquals((errors[0].args[0] as Error).message, "scripted failure");
	assertEquals((errors[0].args[1] as FrontierItem).url, `${SITE}/boom`);

	// --- onLinkSkipped: the rejected edge, carrying why ---
	const skipped = argsOf<LinkRecord>(rec.log, "onLinkSkipped");
	const external = skipped.find((link) => link.to === "http://ext.test/x")!;
	assert(external !== undefined, "the off-site link was not reported");
	assertFalse(external.followed);
	assertEquals(external.skipReason, "out-of-scope");
	assertEquals(external.from, `${SITE}/`);

	// --- onProgress: a JSON-serializable snapshot ---
	const progress = argsOf<CrawlStats>(rec.log, "onProgress");
	assertEquals(progress[progress.length - 1].crawlId, crawler.crawlId);
	assertEquals(
		JSON.parse(JSON.stringify(progress[progress.length - 1])),
		progress[progress.length - 1],
	);

	// --- onEnd: the frozen report, identical to the handle's ---
	const ended = argsOf<CrawlReport>(rec.log, "onEnd");
	assertEquals(ended.length, 1);
	assertEquals(ended[0].stoppedBy, "completed");
	assertEquals(ended[0], crawler.report());
});

Deno.test("events — the order is legal", async () => {
	const rec = recordEvents();
	await crawl(`${SITE}/`, {
		fetcher: siteFetch(EVENTS_SITE),
		robots: { respect: false },
		events: rec.events,
	});
	const names = rec.names();

	// nothing is observed before the crawl is announced, or after it has ended
	assertEquals(names[0], "onStart");
	assertEquals(names[names.length - 1], "onEnd");

	// every page is announced before it is finished, and finished exactly once
	for (const url of [`${SITE}/`, `${SITE}/ok`, `${SITE}/boom`]) {
		const start = rec.log.findIndex((e) =>
			e.name === "onPageStart" && (e.args[0] as FrontierItem).url === url
		);
		const done = rec.log.findIndex((e) =>
			e.name === "onPageDone" && (e.args[0] as PageResult).url === url
		);
		assertGreaterOrEqual(start, 0, `no onPageStart for ${url}`);
		assertGreaterOrEqual(done, 0, `no onPageDone for ${url}`);
		assert(start < done, `onPageStart must precede onPageDone for ${url}`);
	}

	// a failure is announced as a failure BEFORE it is announced as done — the whole
	// point of shipping both is that `onPageError` is the earlier, narrower signal
	const failed = rec.log.findIndex((e) => e.name === "onPageError");
	const failedDone = rec.log.findIndex((e) =>
		e.name === "onPageDone" && (e.args[0] as PageResult).url === `${SITE}/boom`
	);
	assert(failed < failedDone);

	// links are reported while reading the page they were found on, so before that
	// page's own onPageDone
	const skipped = rec.log.findIndex((e) => e.name === "onLinkSkipped");
	const homeDone = rec.log.findIndex((e) =>
		e.name === "onPageDone" && (e.args[0] as PageResult).url === `${SITE}/`
	);
	assert(skipped < homeDone);
});

// -----------------------------------------------------------------------------------
// (b) a handler that throws changes nothing
// -----------------------------------------------------------------------------------

/** The report minus everything that legitimately differs between two identical runs. */
function stable(report: CrawlReport): unknown {
	const { crawlId: _id, startedAt: _at, elapsed: _e, pagesPerSecond: _pps, ...stats } =
		report.stats;
	return {
		stoppedBy: report.stoppedBy,
		stoppedReason: report.stoppedReason,
		stats,
		pages: [...report.pages]
			.sort((a, b) => a.url.localeCompare(b.url))
			.map(({ crawlId: _c, requestId: _r, timing: _t, ...page }) => ({
				...page,
				links: page.links,
			})),
		graph: [...report.graph].sort((a, b) =>
			`${a.from} ${a.rawHref}`.localeCompare(`${b.from} ${b.rawHref}`)
		),
	};
}

function runFixture(events?: CrawlEvents): Promise<CrawlReport> {
	return crawl(`${SITE}/`, {
		fetcher: siteFetch(EVENTS_SITE),
		robots: { respect: false },
		concurrency: 1,
		...(events === undefined ? {} : { events }),
	});
}

Deno.test("events — a handler that throws on every event changes nothing", async () => {
	const boom = (): never => {
		throw new Error("handler boom");
	};
	const logger = recordingLogger();

	const clean = await runFixture();
	const hostile = await crawl(`${SITE}/`, {
		fetcher: siteFetch(EVENTS_SITE),
		robots: { respect: false },
		concurrency: 1,
		logger,
		events: {
			onStart: boom,
			onPageStart: boom,
			onPageDone: boom,
			onPageError: boom,
			onLinkSkipped: boom,
			onProgress: boom,
			onEnd: boom,
		},
	});

	assertEquals(stable(hostile), stable(clean));

	// caught, not swallowed silently: every throw is named at warn level
	const warnings = logger.messages("warn").filter((line) =>
		line.includes("event handler")
	);
	assertGreaterOrEqual(warnings.length, 7);
	for (const name of ["onStart", "onPageDone", "onEnd"]) {
		assert(
			warnings.some((line) => line.includes(name)),
			`no warning named ${name}`,
		);
	}
});

Deno.test("events — an async handler is not awaited, and its rejection is caught", async () => {
	const logger = recordingLogger();
	let resolveSlow: () => void = () => {};
	const slow = new Promise<void>((resolve) => {
		resolveSlow = resolve;
	});

	const report = await crawl(`${SITE}/`, {
		fetcher: siteFetch(EVENTS_SITE),
		robots: { respect: false },
		logger,
		events: {
			// never settles until this test says so — a crawl that awaited its
			// observers would hang here instead of returning
			onPageDone: () => slow as unknown as void,
			onEnd: (): void => {
				throw new Error("sync boom");
			},
			onStart: async () => {
				await Promise.resolve();
				throw new Error("async boom");
			},
		},
	});
	resolveSlow();

	assertEquals(report.stoppedBy, "completed");
	// the rejected promise was caught rather than left to take the process down
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert(
		logger.messages("warn").some((line) =>
			line.includes("onStart") && line.includes("async boom")
		),
	);
});

// -----------------------------------------------------------------------------------
// (c) onProgress is throttled, and always emitted once more before onEnd
// -----------------------------------------------------------------------------------

/** One page slow enough that a short `progressInterval` fires several times over it. */
const SLOW_SITE: MiniSite = {
	[`${SITE}/`]: { html: `<title>Home</title><a href="/slow">slow</a>` },
	[`${SITE}/slow`]: { html: `<title>Slow</title>`, delayMs: 250 },
};

Deno.test("events — onProgress fires at most once per interval, plus one before onEnd", async () => {
	const rec = recordEvents();
	const interval = 25;
	const report = await crawl(`${SITE}/`, {
		fetcher: siteFetch(SLOW_SITE),
		robots: { respect: false },
		progressInterval: interval,
		events: rec.events,
	});

	const names = rec.names();
	const count = names.filter((name) => name === "onProgress").length;

	// the timer actually ran — otherwise the upper bound below proves nothing
	assertGreaterOrEqual(count, 2);
	// no more often than asked: at most one per elapsed interval, plus the final
	// emit, plus one interval of slack for the timer that straddles the end
	const allowed = Math.ceil(report.stats.elapsed / interval) + 2;
	assert(
		count <= allowed,
		`onProgress fired ${count}× over ${report.stats.elapsed}ms (max ${allowed})`,
	);

	// "exactly once more immediately before onEnd"
	assertEquals(names[names.length - 1], "onEnd");
	assertEquals(names[names.length - 2], "onProgress");
});

Deno.test("events — an interval longer than the crawl leaves only the final emit", async () => {
	const rec = recordEvents();
	await crawl(`${SITE}/`, {
		fetcher: siteFetch(EVENTS_SITE),
		robots: { respect: false },
		progressInterval: 60_000,
		events: rec.events,
	});

	const names = rec.names();
	assertEquals(names.filter((name) => name === "onProgress").length, 1);
	assertEquals(names[names.length - 2], "onProgress");
	assertEquals(names[names.length - 1], "onEnd");
});

Deno.test("events — no onProgress handler means no timer at all", async () => {
	// nothing to assert beyond "this returns and Deno's timer sanitizer is happy":
	// an armed interval that outlived the crawl would fail this test outright
	const report = await crawl(`${SITE}/`, {
		fetcher: siteFetch(SLOW_SITE),
		robots: { respect: false },
		progressInterval: 1,
		events: { onEnd: () => {} },
	});
	assertEquals(report.stoppedBy, "completed");
});
