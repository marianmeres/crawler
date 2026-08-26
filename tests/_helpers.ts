/**
 * Test-only transport fakes: a complete `FetchResult` from parts, a `FetchFn` over a
 * canned mini-site, and a logger that records instead of printing.
 *
 * **No engine test opens a socket.** The engine takes `fetcher: siteFetch(SMALL_SITE)`
 * directly (a bare `FetchFn` is an accepted `CrawlOptions.fetcher`), and every suite
 * asserts what landed in `fake.calls` — which doubles as the proof that nothing else
 * was fetched.
 *
 * page-fetcher solved "fabricate a `FetchResult` without a network" for its own tests,
 * but those helpers are unpublished test code reaching into its internals, so this is a
 * small independent copy built only from the public types.
 *
 * @module
 */

import { PageFetchError } from "@marianmeres/page-fetcher";
import type {
	FetchFn,
	FetchRequest,
	FetchResult,
	Logger,
	PageFetchErrorKind,
} from "@marianmeres/page-fetcher";

const encoder = new TextEncoder();

/** One canned page of a fixture site. */
export interface FakePage {
	/** Default `200`, or `301` when {@linkcode FakePage.redirectTo} is set. */
	status?: number;
	/** Default `"text/html"`. */
	contentType?: string;
	/** Response body. Default `""`. */
	html?: string;
	/** Extra response headers. */
	headers?: Record<string, string>;
	/** Redirect target; the chain is followed and `redirects[]`/`finalUrl` synthesized. */
	redirectTo?: string;
	/** Scripted latency, in ms. Honors the request signal. Default: resolves instantly. */
	delayMs?: number;
	/** Scripted failure: the fetch throws this `PageFetchError` instead of answering. */
	error?: { kind: PageFetchErrorKind; message?: string; status?: number };
}

/**
 * Absolute URL → page. `robots.txt` and `sitemap.xml` are entries like any other, which
 * is the point: the engine reaches them through the same fake transport.
 */
export type MiniSite = Record<string, FakePage>;

/** A {@linkcode siteFetch} function plus the requests it received, in order. */
export type RecordingFetch = FetchFn & { calls: FetchRequest[] };

/** How many `redirectTo` hops are followed before the chain is called a loop. */
const MAX_REDIRECTS = 10;

/**
 * Build a complete {@linkcode FetchResult} from the few fields a test cares about.
 *
 * The body accessors are closures over `body`, so nothing is copied and nothing is
 * decoded until a caller asks.
 */
export function makeResult(
	init:
		& Partial<Omit<FetchResult, "text" | "bytes" | "headers">>
		& { url: string; body?: string; headers?: HeadersInit },
): FetchResult {
	const body = init.body ?? "";
	const bytes = encoder.encode(body);
	const hasBody = init.hasBody ?? true;
	const status = init.status ?? 200;

	const result: FetchResult = {
		ok: init.ok ?? (status >= 200 && status < 300),
		url: init.url,
		finalUrl: init.finalUrl ?? init.url,
		status,
		headers: new Headers(init.headers),
		redirects: init.redirects ?? [],
		requestId: init.requestId ?? crypto.randomUUID(),
		hasBody,
		text: () => hasBody ? Promise.resolve(body) : Promise.reject(noBody(init.url)),
		bytes: () => hasBody ? Promise.resolve(bytes) : Promise.reject(noBody(init.url)),
		fromCache: init.fromCache ?? false,
		notModified: init.notModified ?? false,
		timing: init.timing ?? { startedAt: 0, endedAt: 0, total: 0 },
		attempts: init.attempts ?? 1,
		adapter: init.adapter ?? "fake",
	};

	if (init.statusText !== undefined) result.statusText = init.statusText;
	if (init.contentType !== undefined) result.contentType = init.contentType;
	if (init.charset !== undefined) result.charset = init.charset;
	if (hasBody) result.size = init.size ?? bytes.byteLength;
	else if (init.size !== undefined) result.size = init.size;
	if (init.meta !== undefined) result.meta = init.meta;
	if (init.extra !== undefined) result.extra = init.extra;

	return result;
}

/**
 * A {@linkcode FetchFn} serving `site`: exact-string lookup of `req.url`, unknown URLs
 * answering `404`.
 *
 * It never sleeps and never throws unless the matched {@linkcode FakePage} scripts it
 * to, and every request is appended to `calls` before anything else happens.
 */
export function siteFetch(site: MiniSite): RecordingFetch {
	const calls: FetchRequest[] = [];

	const fetch: FetchFn = async (req) => {
		calls.push(req);

		let url = req.url;
		const redirects: string[] = [];

		for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
			const page: FakePage | undefined = site[url];

			if (page?.delayMs) await sleep(page.delayMs, req.signal, url);
			if (req.signal?.aborted) throw aborted(url);
			if (page?.error) {
				throw new PageFetchError({ url, ...page.error });
			}

			if (page?.redirectTo !== undefined) {
				redirects.push(url);
				url = new URL(page.redirectTo, url).href;
				continue;
			}

			const hasBody = req.retainBody !== false;
			const status = page?.status ?? (page === undefined ? 404 : 200);
			const contentType = page?.contentType ?? "text/html";

			return makeResult({
				url: req.url,
				finalUrl: url,
				redirects,
				status,
				body: page?.html ?? (page === undefined ? "not found" : ""),
				hasBody,
				contentType,
				charset: "utf-8",
				headers: {
					"content-type": `${contentType}; charset=utf-8`,
					...page?.headers,
				},
				...(req.requestId === undefined ? {} : { requestId: req.requestId }),
				...(req.meta === undefined ? {} : { meta: req.meta }),
			});
		}

		throw new PageFetchError({ kind: "too-many-redirects", url: req.url });
	};

	return Object.assign(fetch, { calls });
}

/** A clog-shaped {@linkcode Logger} that records instead of printing. */
export function recordingLogger(): Logger & {
	messages(level?: "debug" | "log" | "warn" | "error"): string[];
} {
	const lines: { level: string; text: string }[] = [];
	// deno-lint-ignore no-explicit-any
	const record = (level: string) => (...args: any[]) => {
		lines.push({ level, text: args.map(stringify).join(" ") });
	};

	return {
		debug: record("debug"),
		log: record("log"),
		warn: record("warn"),
		error: record("error"),
		messages(level) {
			return lines
				.filter((line) => level === undefined || line.level === level)
				.map((line) => line.text);
		},
	};
}

// -----------------------------------------------------------------------------------
// the shared fixture site
// -----------------------------------------------------------------------------------

/** Origin of {@linkcode SMALL_SITE}. `.test` is reserved by RFC 6761 — never resolvable. */
export const SITE = "http://site.test";

/**
 * The fixture mini-site every engine suite crawls.
 *
 * Each entry earns its place:
 *
 * - `/a` ↔ `/b` is a cycle, so the visited set is what terminates the crawl.
 * - `/dup?utm_source=x` (from `/`) and `/dup` (from `/b`) are the same page under two
 *   spellings — the normalization dedupe.
 * - `/redirect` → `/target` proves a redirect is an *attribute* of the item, never a
 *   frontier item of its own.
 * - `/private/secret` is what `/robots.txt` disallows.
 * - `/t/a/b/a/b/a/b` is a repeated-segment trap.
 * - `http://ext.test/x` is off-site.
 * - `/sitemap-only` is linked from nowhere: `robots.sitemaps` is the only way to reach it.
 */
export const SMALL_SITE: MiniSite = {
	[`${SITE}/`]: {
		html: `<!doctype html>
<html lang="en">
<head><title>Home</title></head>
<body>
	<nav><a href="/a">A</a></nav>
	<main>
		<a href="/b">B</a>
		<a href="/dup?utm_source=x">Dup, tracked</a>
		<a href="/redirect">Redirect</a>
		<a href="/private/secret">Secret</a>
		<a href="http://ext.test/x">External</a>
		<a href="/t/a/b/a/b/a/b">Trap</a>
	</main>
</body>
</html>`,
	},
	[`${SITE}/a`]: {
		html: `<title>A</title><a href="/b">to b</a><a href="/">home</a>`,
	},
	[`${SITE}/b`]: {
		html: `<title>B</title><a href="/a">to a</a><a href="/dup">dup, clean</a>`,
	},
	[`${SITE}/dup`]: { html: `<title>Dup</title>` },
	[`${SITE}/redirect`]: { redirectTo: `${SITE}/target` },
	[`${SITE}/target`]: { html: `<title>Target</title>` },
	[`${SITE}/private/secret`]: { html: `<title>Secret</title>` },
	[`${SITE}/t/a/b/a/b/a/b`]: { html: `<title>Trap</title>` },
	[`${SITE}/robots.txt`]: {
		contentType: "text/plain",
		html: `User-agent: *
Disallow: /private/

Sitemap: ${SITE}/sitemap.xml
`,
	},
	[`${SITE}/sitemap.xml`]: {
		contentType: "application/xml",
		html: `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
	<url><loc>${SITE}/sitemap-only</loc></url>
</urlset>`,
	},
	[`${SITE}/sitemap-only`]: { html: `<title>Sitemap only</title>` },
	"http://ext.test/x": { html: `<title>External</title><a href="/y">y</a>` },
};

/** Every URL {@linkcode SMALL_SITE} serves, for coverage assertions. */
export const SMALL_SITE_URLS: readonly string[] = Object.keys(SMALL_SITE);

// -----------------------------------------------------------------------------------

function noBody(url: string): PageFetchError {
	return new PageFetchError({
		kind: "no-body",
		url,
		details: { reason: "retain-body" },
	});
}

function aborted(url: string): PageFetchError {
	return new PageFetchError({ kind: "aborted", url });
}

function sleep(ms: number, signal: AbortSignal | undefined, url: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		function onAbort() {
			clearTimeout(timer);
			reject(aborted(url));
		}
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function stringify(value: unknown): string {
	if (typeof value === "string") return value;
	if (value instanceof Error) return `${value.name}: ${value.message}`;
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}
