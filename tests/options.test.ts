import { assertEquals, assertNotStrictEquals, assertThrows } from "@std/assert";
import {
	DEFAULT_USER_AGENT,
	resolveCrawlOptions,
	type ResolvedCrawlOptions,
} from "../src/options.ts";
import type { CrawlOptions, LinkRegion } from "../src/mod.ts";

/**
 * The whole default table in one assertion. If a documented default on `CrawlOptions`
 * changes, this is the test that has to change with it — which is the point.
 */
const DEFAULTS: ResolvedCrawlOptions = {
	fetcher: undefined,
	userAgent: DEFAULT_USER_AGENT,
	concurrency: 5,
	perHostConcurrency: 2,
	perHostDelay: 0,
	strategy: "bfs",
	priority: undefined,
	maxQueued: 100_000,
	maxDepth: Infinity,
	maxPages: Infinity,
	maxDuration: Infinity,
	maxTotalBytes: Infinity,
	scope: {
		subdomains: "same-host",
		include: [],
		exclude: [],
		pathPrefix: [],
		allowExternal: false,
		checkExternal: false,
		followNofollow: false,
		followRegions: [],
		maxUrlLength: 2048,
	},
	normalize: {},
	extract: {
		anchors: true,
		canonical: true,
		nextPrev: true,
		metaRefresh: true,
		alternate: false,
		iframes: false,
		assets: false,
		srcset: false,
		maxAnchorText: 200,
		maxLinks: 10_000,
	},
	robots: {
		respect: true,
		sitemaps: false,
		crawlDelayCap: 30_000,
		maxBytes: 512_000,
		fetch: undefined,
	},
	traps: {
		maxSegmentRepeat: 3,
		maxPathDepth: 20,
		maxQueryParams: 32,
		maxUrlsPerPath: 200,
		softDupThreshold: 10,
	},
	followCanonical: false,
	recrawl: false,
	allowPrivateHosts: true,
	stores: {},
	collect: { pages: false, graph: false },
	beforeExtract: undefined,
	shouldVisit: undefined,
	onPage: undefined,
	onLink: undefined,
	events: {},
	progressInterval: 500,
	logger: undefined,
	signal: undefined,
};

Deno.test("resolveCrawlOptions() — the documented defaults, exhaustively", () => {
	assertEquals(resolveCrawlOptions(), DEFAULTS);
	assertEquals(resolveCrawlOptions({}), DEFAULTS);
});

Deno.test("resolveCrawlOptions() — explicit values win over defaults", () => {
	const signal = AbortSignal.abort();
	const resolved = resolveCrawlOptions({
		userAgent: "test-agent",
		concurrency: 1,
		perHostConcurrency: 1,
		perHostDelay: 250,
		maxQueued: 10,
		maxDepth: 3,
		maxPages: 42,
		maxDuration: 1_000,
		maxTotalBytes: 999,
		followCanonical: true,
		recrawl: true,
		allowPrivateHosts: false,
		progressInterval: 0,
		signal,
	});

	assertEquals(resolved.userAgent, "test-agent");
	assertEquals(resolved.concurrency, 1);
	assertEquals(resolved.perHostConcurrency, 1);
	assertEquals(resolved.perHostDelay, 250);
	assertEquals(resolved.maxQueued, 10);
	assertEquals(resolved.maxDepth, 3);
	assertEquals(resolved.maxPages, 42);
	assertEquals(resolved.maxDuration, 1_000);
	assertEquals(resolved.maxTotalBytes, 999);
	assertEquals(resolved.followCanonical, true);
	assertEquals(resolved.recrawl, true);
	assertEquals(resolved.allowPrivateHosts, false);
	assertEquals(resolved.progressInterval, 0);
	assertEquals(resolved.signal, signal);
});

Deno.test("resolveCrawlOptions() — sub-option objects are merged, not replaced", () => {
	const resolved = resolveCrawlOptions({
		scope: { subdomains: "same-site" },
		extract: { assets: true },
		robots: { respect: false },
		traps: { maxPathDepth: 5 },
		collect: { pages: true },
	});

	// the one field given...
	assertEquals(resolved.scope.subdomains, "same-site");
	assertEquals(resolved.extract.assets, true);
	assertEquals(resolved.robots.respect, false);
	assertEquals(resolved.traps.maxPathDepth, 5);
	assertEquals(resolved.collect.pages, true);

	// ...and its siblings still defaulted
	assertEquals(resolved.scope.maxUrlLength, 2048);
	assertEquals(resolved.extract.anchors, true);
	assertEquals(resolved.robots.crawlDelayCap, 30_000);
	assertEquals(resolved.traps.maxSegmentRepeat, 3);
	assertEquals(resolved.collect.graph, false);
});

Deno.test("resolveCrawlOptions() — pathPrefix is always an array, always a copy", () => {
	assertEquals(
		resolveCrawlOptions({ scope: { pathPrefix: "/docs" } }).scope.pathPrefix,
		[
			"/docs",
		],
	);

	const given = ["/a", "/b"];
	const resolved = resolveCrawlOptions({ scope: { pathPrefix: given } });
	assertEquals(resolved.scope.pathPrefix, given);
	// caller mutating their array afterwards must not reach into the crawl
	assertNotStrictEquals(resolved.scope.pathPrefix, given);
});

Deno.test("resolveCrawlOptions() — followRegions defaults to [] and is copied", () => {
	// [] means "no region filtering", NOT "follow nothing" — the engine treats an empty
	// list as the feature being off, which is what keeps it backwards-compatible.
	assertEquals(resolveCrawlOptions({}).scope.followRegions, []);

	const given: LinkRegion[] = ["main", "article"];
	const resolved = resolveCrawlOptions({ scope: { followRegions: given } });
	assertEquals(resolved.scope.followRegions, given);
	assertNotStrictEquals(resolved.scope.followRegions, given);
});

Deno.test("resolveCrawlOptions() — stores are copied, absent ones stay absent", () => {
	assertEquals(resolveCrawlOptions().stores, {});

	const stores = {};
	const resolved = resolveCrawlOptions({ stores });
	assertNotStrictEquals(resolved.stores, stores);
});

Deno.test('resolveCrawlOptions() — strategy "priority" requires a priority function', () => {
	assertThrows(
		() => resolveCrawlOptions({ strategy: "priority" }),
		TypeError,
		"requires options.priority",
	);

	const priority = (): number => 0;
	const resolved = resolveCrawlOptions({ strategy: "priority", priority });
	assertEquals(resolved.strategy, "priority");
	assertEquals(resolved.priority, priority);

	// only "priority" demands it; the others merely ignore it
	assertEquals(resolveCrawlOptions({ strategy: "dfs" }).strategy, "dfs");
});

Deno.test("resolveCrawlOptions() — caps must be > 0, and Infinity means unlimited", () => {
	const positives: (keyof ReturnType<typeof resolveCrawlOptions>)[] = [
		"concurrency",
		"perHostConcurrency",
		"maxQueued",
		"maxDepth",
		"maxPages",
		"maxDuration",
		"maxTotalBytes",
	];

	for (const key of positives) {
		for (const bad of [0, -1, NaN]) {
			assertThrows(
				() => resolveCrawlOptions({ [key]: bad }),
				TypeError,
				`options.${key}`,
				`${key}: ${bad} should have been rejected`,
			);
		}
		// "no limit" is spelled Infinity, and is accepted
		assertEquals(
			resolveCrawlOptions({ [key]: Infinity })[key],
			Infinity,
			`${key}: Infinity should be accepted`,
		);
	}
});

Deno.test("resolveCrawlOptions() — a trap cap of 0 is a mistake, not 'unlimited'", () => {
	assertThrows(
		() => resolveCrawlOptions({ traps: { maxUrlsPerPath: 0 } }),
		TypeError,
		"options.traps.maxUrlsPerPath must be > 0",
	);
	assertEquals(
		resolveCrawlOptions({ traps: { maxUrlsPerPath: Infinity } }).traps.maxUrlsPerPath,
		Infinity,
	);
});

Deno.test("resolveCrawlOptions() — delays and intervals may be 0, never negative", () => {
	assertEquals(resolveCrawlOptions({ perHostDelay: 0 }).perHostDelay, 0);
	assertEquals(resolveCrawlOptions({ progressInterval: 0 }).progressInterval, 0);
	assertEquals(
		resolveCrawlOptions({ robots: { crawlDelayCap: 0 } }).robots.crawlDelayCap,
		0,
	);

	assertThrows(
		() => resolveCrawlOptions({ perHostDelay: -1 }),
		TypeError,
		"options.perHostDelay must be >= 0",
	);
	assertThrows(
		() => resolveCrawlOptions({ progressInterval: NaN }),
		TypeError,
		"options.progressInterval must be >= 0",
	);
});

Deno.test("resolveCrawlOptions() — nested caps are validated too", () => {
	assertThrows(
		() => resolveCrawlOptions({ scope: { maxUrlLength: 0 } }),
		TypeError,
		"options.scope.maxUrlLength",
	);
	assertThrows(
		() => resolveCrawlOptions({ extract: { maxLinks: -5 } }),
		TypeError,
		"options.extract.maxLinks",
	);
	assertThrows(
		() => resolveCrawlOptions({ robots: { maxBytes: 0 } }),
		TypeError,
		"options.robots.maxBytes",
	);
});

Deno.test("resolveCrawlOptions() — a count has to be a whole number", async (t) => {
	await t.step("a fractional count is a TypeError, not a silent default", () => {
		// `extract.maxLinks: 0.5` used to pass validation, reach ./extract, fail its
		// own range check there and come back as 10_000 — the opposite of the ask,
		// with no error anywhere
		const bad: [CrawlOptions, string][] = [
			[{ concurrency: 2.5 }, "concurrency"],
			[{ perHostConcurrency: 1.5 }, "perHostConcurrency"],
			[{ maxQueued: 10.5 }, "maxQueued"],
			[{ maxDepth: 1.5 }, "maxDepth"],
			[{ maxPages: 99.9 }, "maxPages"],
			[{ scope: { maxUrlLength: 2048.5 } }, "scope.maxUrlLength"],
			[{ extract: { maxLinks: 0.5 } }, "extract.maxLinks"],
			[{ extract: { maxAnchorText: 2.7 } }, "extract.maxAnchorText"],
			[{ robots: { maxBytes: 1.5 } }, "robots.maxBytes"],
			[{ traps: { maxSegmentRepeat: 3.5 } }, "traps.maxSegmentRepeat"],
			[{ traps: { maxPathDepth: 20.5 } }, "traps.maxPathDepth"],
			[{ traps: { maxQueryParams: 32.5 } }, "traps.maxQueryParams"],
			[{ traps: { maxUrlsPerPath: 200.5 } }, "traps.maxUrlsPerPath"],
			[{ traps: { softDupThreshold: 10.5 } }, "traps.softDupThreshold"],
		];
		for (const [options, name] of bad) {
			assertThrows(
				() => resolveCrawlOptions(options),
				TypeError,
				`options.${name} must be a whole number`,
			);
		}
	});

	await t.step("Infinity is still how 'no limit' is spelled", () => {
		const resolved = resolveCrawlOptions({
			maxDepth: Infinity,
			maxPages: Infinity,
			extract: { maxLinks: Infinity },
		});
		assertEquals(resolved.maxDepth, Infinity);
		assertEquals(resolved.maxPages, Infinity);
		assertEquals(resolved.extract.maxLinks, Infinity);
	});

	await t.step("time and byte quantities may be fractional", () => {
		// half a millisecond is a coherent thing to ask for; half a link is not
		const resolved = resolveCrawlOptions({
			perHostDelay: 0.5,
			maxDuration: 1500.5,
			maxTotalBytes: 1024.5,
			progressInterval: 250.5,
			robots: { crawlDelayCap: 1500.5 },
		});
		assertEquals(resolved.perHostDelay, 0.5);
		assertEquals(resolved.maxDuration, 1500.5);
		assertEquals(resolved.maxTotalBytes, 1024.5);
		assertEquals(resolved.progressInterval, 250.5);
		assertEquals(resolved.robots.crawlDelayCap, 1500.5);
	});

	await t.step("`extract.maxAnchorText: 0` is still meaningful", () => {
		assertEquals(
			resolveCrawlOptions({ extract: { maxAnchorText: 0 } })
				.extract.maxAnchorText,
			0,
		);
	});
});
