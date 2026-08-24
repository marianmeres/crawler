/**
 * The other half of robots: the per-page directives, in `<meta name="robots">` and in
 * the `X-Robots-Tag` response header.
 *
 * These decide whether a page's links may be *followed* (`nofollow` stops expansion) and
 * record whether it may be indexed (`noindex` is reported, never acted on — indexing is
 * the consumer's business, not the crawler's). Merging a page's meta tag with its header
 * is the crawl loop's job, most-restrictive-wins; each function here answers only for
 * its own source.
 *
 * @module
 */

import { parseAttrs, scanTokens } from "./_html.ts";

/** What a page said about itself. */
export interface RobotsDirectives {
	noindex: boolean;
	nofollow: boolean;
	/**
	 * Every directive token that applied, lowercased, trimmed and deduped, in the order
	 * they were seen — including the ones we do not act on (`noarchive`, `nosnippet`,
	 * `max-snippet:-1`, …), so a consumer can inspect them without reparsing.
	 *
	 * Tokens from a scoped `X-Robots-Tag` group addressed to *another* bot are not here:
	 * they did not apply.
	 */
	raw: string[];
}

/**
 * `X-Robots-Tag` directives that carry a value after a colon. They have to be listed,
 * because `name: value` is also how the header scopes directives to one bot — without
 * this set, `unavailable_after: 25 Jun 2010` would read as a group addressed to a
 * crawler named "unavailable_after" and silently drop everything after it.
 */
const VALUED_DIRECTIVES: ReadonlySet<string> = new Set([
	"unavailable_after",
	"max-snippet",
	"max-image-preview",
	"max-video-preview",
]);

interface Accumulator {
	noindex: boolean;
	nofollow: boolean;
	raw: string[];
	seen: Set<string>;
}

function accumulator(): Accumulator {
	return { noindex: false, nofollow: false, raw: [], seen: new Set() };
}

function finish(acc: Accumulator): RobotsDirectives {
	return { noindex: acc.noindex, nofollow: acc.nofollow, raw: acc.raw };
}

/**
 * Fold one directive token in. The vocabulary we act on is tiny — `noindex`,
 * `nofollow`, `none` (both) and `all` (neither, and never a cancellation: merging is
 * most-restrictive, so `all` alongside a `noindex` changes nothing).
 */
function applyToken(acc: Accumulator, token: string): void {
	const value = token.trim().toLowerCase();
	if (value === "") return;

	if (!acc.seen.has(value)) {
		acc.seen.add(value);
		acc.raw.push(value);
	}

	switch (value) {
		case "noindex":
			acc.noindex = true;
			break;
		case "nofollow":
			acc.nofollow = true;
			break;
		case "none":
			acc.noindex = true;
			acc.nofollow = true;
			break;
	}
}

/**
 * Robots directives from a document's `<meta>` tags.
 *
 * `names` says which `<meta name="…">` values address us; the default is `["robots"]`,
 * and the crawl loop adds its own product token so a site can target this crawler
 * specifically. Matching is case-insensitive on both the name and the content.
 *
 * Every matching tag is merged, most-restrictive-wins. Because this walks the same
 * scanner as {@linkcode "./extract-links.ts".extractLinks}, a `<meta name="robots">`
 * written inside a comment or a `<script>` string is correctly *not* a directive.
 *
 * Never throws; missing or unparsable input yields all-false with an empty `raw`.
 *
 * @example
 * ```ts
 * parseMetaRobots(`<meta name="ROBOTS" content="NoIndex, nofollow">`);
 * // => { noindex: true, nofollow: true, raw: ["noindex", "nofollow"] }
 * ```
 */
export function parseMetaRobots(
	html: string,
	opts?: { names?: string[] },
): RobotsDirectives {
	const acc = accumulator();
	if (typeof html !== "string" || html === "") return finish(acc);

	const names = new Set(
		(opts?.names ?? ["robots"])
			.map((name) => String(name).trim().toLowerCase())
			.filter((name) => name !== ""),
	);
	if (names.size === 0) return finish(acc);

	try {
		for (const token of scanTokens(html)) {
			if (token.kind !== "tag" || token.closing || token.name !== "meta") {
				continue;
			}
			const attrs = parseAttrs(token.attrsSource);
			const name = attrs.get("name")?.trim().toLowerCase();
			if (name === undefined || !names.has(name)) continue;

			const content = attrs.get("content");
			if (!content) continue;
			for (const part of content.split(",")) applyToken(acc, part);
		}
	} catch {
		// never throws
	}

	return finish(acc);
}

/**
 * Robots directives from an `X-Robots-Tag` header value.
 *
 * Pass what `FetchResult.headers.get("x-robots-tag")` returned: repeated headers arrive
 * joined with `", "`, which this handles. Directives before any `botname:` prefix apply
 * to everyone; a `botname: directive` starts a group that applies only while `botName`
 * matches it (case-insensitively, as a token *within* `botName`, so `googlebot` addresses
 * `googlebot/2.1`), and that group runs until the next one begins.
 *
 * Two consequences worth knowing:
 *
 * - joining is lossy — `X-Robots-Tag: googlebot: nofollow` followed by
 *   `X-Robots-Tag: noindex` reaches us as `googlebot: nofollow, noindex`, in which the
 *   unscoped `noindex` is indistinguishable from a second googlebot directive. It is
 *   attributed to the group, which is what Google's own documented examples do
 * - a directive whose *value* contains a comma (an RFC-822 `unavailable_after` date) is
 *   split by it; the leftover lands in `raw` and affects nothing
 *
 * Never throws; missing or empty input yields all-false with an empty `raw`.
 *
 * @example
 * ```ts
 * parseXRobotsTag("noindex, otherbot: nofollow", { botName: "mybot" });
 * // => { noindex: true, nofollow: false, raw: ["noindex"] }
 * ```
 */
export function parseXRobotsTag(
	header: string | null | undefined,
	opts?: { botName?: string },
): RobotsDirectives {
	const acc = accumulator();
	if (typeof header !== "string" || header.trim() === "") return finish(acc);

	const botName = typeof opts?.botName === "string"
		? opts.botName.trim().toLowerCase()
		: "";
	// everything before the first group is addressed to every crawler
	let applies = true;

	for (const item of header.split(",")) {
		const part = item.trim();
		if (part === "") continue;

		const colon = part.indexOf(":");
		if (colon >= 0) {
			const left = part.slice(0, colon).trim().toLowerCase();
			if (!VALUED_DIRECTIVES.has(left)) {
				applies = left !== "" && botName !== "" && botName.includes(left);
				const first = part.slice(colon + 1).trim();
				if (applies && first !== "") applyToken(acc, first);
				continue;
			}
		}

		if (applies) applyToken(acc, part);
	}

	return finish(acc);
}
