import { assertEquals } from "@std/assert";
import {
	CRAWL_JOB_TYPE,
	type CrawlJobPayload,
	type CrawlJobResult,
	type SerializableCrawlOptions,
} from "../src/steve/mod.ts";

/**
 * Instantiating this with anything but `never` is a type error — the point is that it
 * fails `deno check`, so there is nothing here to run.
 */
type AssertNever<T extends never> = T;

/** The keys of `T` whose value is a function. */
type FunctionTypedKeys<T> = {
	[K in keyof T]: T[K] extends (...a: never) => unknown ? K : never;
}[keyof T];

/**
 * The assertion that keeps job mode honest: a payload is JSONB, so no top-level property
 * of {@linkcode SerializableCrawlOptions} may be function-typed. When `CrawlOptions`
 * grows a hook and nobody omits it here, this stops compiling with the offending key as
 * the error — the earliest possible warning that payloads would silently drop it.
 *
 * `Required<>` matters: every `CrawlOptions` key is optional, and `((…) => x) | undefined`
 * does not extend a function type, so without it the check would pass unconditionally.
 */
type _NoFunctionTypedOptions = AssertNever<
	FunctionTypedKeys<Required<SerializableCrawlOptions>>
>;

/** The nested groups are re-mapped by hand, so assert their RegExp arms really went. */
type ScopePatterns = NonNullable<SerializableCrawlOptions["scope"]>;
type StripParams = NonNullable<SerializableCrawlOptions["normalize"]>["stripParams"];

type _StringPatternsOnly = AssertNever<
	| Exclude<NonNullable<ScopePatterns["include"]>[number], string>
	| Exclude<NonNullable<ScopePatterns["exclude"]>[number], string>
	| Exclude<NonNullable<StripParams>[number], string>
>;

/** Decision 3, at compile time: the summary carries no unbounded map. */
type _NoByHost = AssertNever<Extract<keyof CrawlJobResult["stats"], "byHost">>;

Deno.test("a fully populated payload round-trips through JSON unchanged", () => {
	const payload: CrawlJobPayload = {
		seeds: ["https://example.com"],
		crawlUid: crypto.randomUUID(),
		options: {
			maxPages: 500,
			maxDuration: 60_000,
			perHostDelay: 250,
			userAgent: "test-agent",
			strategy: "bfs",
			persistBody: true,
			scope: { subdomains: "same-site", exclude: ["/search"] },
			robots: { respect: true, sitemaps: true },
			normalize: { stripParams: ["utm_source"] },
			extract: { assets: true },
			traps: { maxUrlsPerPath: 50 },
		},
	};

	assertEquals(JSON.parse(JSON.stringify(payload)), payload);
});

Deno.test("a result round-trips through JSON unchanged", () => {
	const result: CrawlJobResult = {
		crawlUid: crypto.randomUUID(),
		stoppedBy: "maxPages",
		stats: {
			crawlId: crypto.randomUUID(),
			queued: 0,
			inFlight: 0,
			done: 3,
			failed: 1,
			skipped: 2,
			bytes: 4096,
			startedAt: Date.now(),
			elapsed: 120,
			pagesPerSecond: 25,
			byStatus: { 200: 3, 404: 1 },
			skippedByReason: { "out-of-scope": 2 },
		},
		attempt: 1,
		resumed: false,
	};

	assertEquals(JSON.parse(JSON.stringify(result)), result);
});

Deno.test("CRAWL_JOB_TYPE is the documented default", () => {
	assertEquals(CRAWL_JOB_TYPE, "crawl");
});
