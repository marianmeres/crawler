/**
 * Internal — the per-origin robots.txt cache and the enforcement policy around it.
 *
 * Parsing is `./extract`'s ({@linkcode parseRobotsTxt}); this module owns *fetching*
 * one robots.txt per origin, caching it for the run, and turning the awkward cases into
 * a decision:
 *
 * - **fetch error or any 4xx → allow everything.** A site with no robots.txt has no
 *   rules, and "I could not reach it" is indistinguishable from that.
 * - **5xx → allow nothing**, with one warning per origin. The polite reading of "I
 *   cannot tell you my rules right now" is to stay away.
 * - **A robots.txt served as HTML** (the SPA catch-all route) is not a robots.txt. It
 *   is read as "no rules" rather than parsed into accidental directives.
 *
 * The cache is **per run and has no TTL**: a multi-day crawl re-reads robots only
 * across runs. Concurrent misses for one origin share a single in-flight promise, so N
 * workers discovering N links on a new host cost one request, not N.
 *
 * @module
 */

import { createFetcher } from "@marianmeres/page-fetcher";
import { createHttpAdapter } from "@marianmeres/page-fetcher/adapters";
import type { Fetcher, FetchFn, Logger } from "@marianmeres/page-fetcher";

import {
	parseRobotsTxt,
	robotsAllowAll,
	robotsDisallowAll,
} from "../extract/robots-txt.ts";
import type { RobotsTxt } from "../extract/robots-txt.ts";
import { maskUserinfo } from "../url/_mask-userinfo.ts";

/** Content types that mean "this is a fallback page, not a robots.txt". */
const HTML_CONTENT_TYPES: ReadonlySet<string> = new Set([
	"text/html",
	"application/xhtml+xml",
]);

/** What {@linkcode createRobotsGate} needs to answer a question. */
export interface RobotsGateOptions {
	/** Honor robots.txt at all. `false` makes every answer "allowed", with no fetching. */
	respect: boolean;
	/** Matched against `User-agent:` groups, and sent as the robots request's own UA. */
	userAgent: string;
	/** Ceiling on an honored `Crawl-delay`, in ms. */
	crawlDelayCap: number;
	/** Byte cap on a robots.txt body. Enforced on the parse, so it holds for any transport. */
	maxBytes: number;
	/**
	 * Transport. Defaults to the crawl's own — see the note on
	 * {@linkcode "../types.ts".RobotsOptions.fetch}. When this is absent *and* no
	 * crawl transport was injected, the gate builds (and disposes) its own small
	 * `text/plain` HTTP fetcher.
	 */
	fetch?: FetchFn;
	logger?: Logger;
	signal?: AbortSignal;
}

/** The engine-facing surface. */
export interface RobotsGate {
	/**
	 * May this URL be fetched? Resolves the origin's rules, fetching and caching them on
	 * the first miss.
	 */
	isAllowed(url: string | URL): Promise<boolean>;
	/**
	 * `Crawl-delay` for a host, in ms, capped — `0` when unknown or absent.
	 *
	 * Synchronous, because the dispatcher reads it while scheduling: it can only know
	 * about origins whose rules have already been resolved, which is exactly the
	 * origins the crawl has reached.
	 */
	crawlDelayMs(host: string): number;
	/**
	 * `Sitemap:` values of an origin, fetching and caching its robots.txt on the first
	 * miss like {@linkcode RobotsGate.isAllowed} does.
	 *
	 * The one thing here that ignores {@linkcode RobotsGateOptions.respect}: sitemap
	 * seeding is not enforcement, and `{ respect: false, sitemaps: true }` is a coherent
	 * pair — "do not obey the rules, but do take the map".
	 */
	sitemapUrls(origin: string): Promise<string[]>;
	/** Release the transport, if this gate built one. Idempotent. */
	dispose(): Promise<void>;
}

/**
 * Build a gate.
 *
 * @example
 * ```ts
 * const gate = createRobotsGate({ respect: true, userAgent: "mybot", crawlDelayCap: 30_000, maxBytes: 512_000 });
 * await gate.isAllowed("https://example.com/private/x"); // => false, if disallowed
 * ```
 */
export function createRobotsGate(opts: RobotsGateOptions): RobotsGate {
	/** origin → resolved rules. Never evicted; one small object per host reached. */
	const cache = new Map<string, RobotsTxt>();
	/** origin → the single in-flight fetch, so concurrent misses share one request. */
	const inFlight = new Map<string, Promise<RobotsTxt>>();
	/** host → capped Crawl-delay in ms, the largest seen across that host's origins. */
	const delays = new Map<string, number>();

	let owned: Fetcher | undefined;
	let fetch = opts.fetch;

	const transport = (): FetchFn => {
		if (fetch !== undefined) return fetch;
		// the doc's dedicated instance: adapter-level `maxBytes` and `allowContentTypes`
		// are not per-request options, so restricting robots means its own fetcher
		owned = createFetcher({
			adapters: createHttpAdapter({
				maxBytes: opts.maxBytes,
				allowContentTypes: ["text/plain"],
				onUnsupportedType: "skip-body",
				logger: opts.logger,
			}),
			userAgent: opts.userAgent,
			logger: opts.logger,
		});
		fetch = (req) => owned!.fetch(req);
		return fetch;
	};

	async function load(origin: string): Promise<RobotsTxt> {
		const url = `${origin}/robots.txt`;
		try {
			const res = await transport()({
				url,
				retainBody: true,
				...(opts.signal === undefined ? {} : { signal: opts.signal }),
			});

			if (res.status >= 500) {
				opts.logger?.warn(
					`[crawl] ${maskUserinfo(url)} answered ${res.status} — ` +
						`treating the whole origin as disallowed`,
				);
				return robotsDisallowAll();
			}
			// 4xx (and anything else without a usable body) means "no rules here"
			if (res.status >= 400 || !res.hasBody) return robotsAllowAll();
			if (HTML_CONTENT_TYPES.has(res.contentType ?? "")) return robotsAllowAll();

			const text = await res.text();
			// enforced here rather than only at the adapter, so the cap still means
			// something when the transport is the crawl's own fetcher
			return parseRobotsTxt(
				text.length > opts.maxBytes ? text.slice(0, opts.maxBytes) : text,
			);
		} catch (e) {
			opts.logger?.debug(
				`[crawl] ${maskUserinfo(url)} could not be fetched, allowing all:`,
				e,
			);
			return robotsAllowAll();
		}
	}

	async function rulesFor(origin: string): Promise<RobotsTxt> {
		const cached = cache.get(origin);
		if (cached !== undefined) return cached;

		let pending = inFlight.get(origin);
		if (pending === undefined) {
			pending = load(origin).then((rules) => {
				cache.set(origin, rules);
				inFlight.delete(origin);
				recordDelay(origin, rules);
				return rules;
			});
			inFlight.set(origin, pending);
		}
		return await pending;
	}

	function recordDelay(origin: string, rules: RobotsTxt): void {
		const seconds = rules.crawlDelay(opts.userAgent);
		if (seconds === undefined || !(seconds > 0)) return;
		const host = hostOf(origin);
		const ms = Math.min(seconds * 1000, opts.crawlDelayCap);
		// being slower than asked is never a violation, so the largest wins when one
		// host serves different rules on http and https
		delays.set(host, Math.max(delays.get(host) ?? 0, ms));
	}

	return {
		async isAllowed(input: string | URL): Promise<boolean> {
			if (!opts.respect) return true;

			let url: URL;
			try {
				url = input instanceof URL ? input : new URL(input);
			} catch {
				// not a URL we could fetch anyway; the scope pipeline already said so
				return true;
			}

			const rules = await rulesFor(url.origin);
			return rules.isAllowed(url.pathname + url.search, opts.userAgent);
		},

		crawlDelayMs(host: string): number {
			if (!opts.respect) return 0;
			return delays.get(host) ?? 0;
		},

		async sitemapUrls(origin: string): Promise<string[]> {
			return (await rulesFor(origin)).sitemaps;
		},

		async dispose(): Promise<void> {
			const toDispose = owned;
			owned = undefined;
			await toDispose?.dispose();
		},
	};
}

function hostOf(origin: string): string {
	try {
		return new URL(origin).hostname;
	} catch {
		return origin;
	}
}
