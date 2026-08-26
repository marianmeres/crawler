/**
 * Sitemap documents: `<urlset>`, `<sitemapindex>`, and the protocol's plain-text form.
 *
 * There is no XML parser here and there is not going to be one. A sitemap is a flat list
 * of `<loc>` values wrapped in two levels of elements, and the documents a crawler meets
 * are routinely truncated, mis-namespaced, served as `text/html` by a CDN error page, or
 * a megabyte of `<url>` blocks that never close. A conforming parser rejects all of
 * those; this one takes what it can read and drops the rest, the same contract every
 * other parser in `./extract` has: **never throws**, worst case returns nothing.
 *
 * Two bounds make that safe rather than merely tolerant:
 *
 * 1. **No scan is unbounded.** Each block's close tag is searched for only up to the
 *    *next* block's open tag, so 50 000 `<url>` elements with no `</url>` in sight cost
 *    one linear pass rather than a quadratic one.
 * 2. **50 000 entries, tail dropped** — the sitemap protocol's own per-file limit.
 *
 * Out of scope, deliberately: RSS/Atom feeds (a legal sitemap format nobody serves as
 * one), and gzip — a `.xml.gz` body is the caller's to decompress, because this module
 * is synchronous and `DecompressionStream` is not.
 *
 * @module
 */

import { decodeEntities } from "./_html.ts";

/** One `<url>` entry of a `<urlset>` document. */
export interface SitemapEntry {
	/** `<loc>`, CDATA-unwrapped, entity-decoded and trimmed. Never empty. */
	url: string;
	/** `<lastmod>` verbatim — a W3C datetime, which the caller parses if it cares. */
	lastmod?: string;
	/** `<changefreq>` verbatim; the protocol's values are advisory and often invented. */
	changefreq?: string;
	/** `<priority>` as a number. Absent when the document's value was not one. */
	priority?: number;
}

/** One `<sitemap>` entry of a `<sitemapindex>` document. */
export interface SitemapIndexEntry {
	/** `<loc>`, CDATA-unwrapped, entity-decoded and trimmed. Never empty. */
	url: string;
	/** `<lastmod>` verbatim. */
	lastmod?: string;
}

/**
 * What {@linkcode parseSitemap} found. The two kinds are what the caller does next: a
 * `urlset` is work, a `sitemapindex` is more documents to fetch.
 */
export type SitemapParseResult =
	| { kind: "urlset"; entries: SitemapEntry[] }
	| { kind: "sitemapindex"; sitemaps: SitemapIndexEntry[] };

/** The sitemap protocol's per-file limit; entries past it are dropped, not an error. */
const MAX_ENTRIES = 50_000;

/**
 * Parse one sitemap document.
 *
 * The rules, in the order they apply:
 *
 * - a body with no `<` at all is the protocol's **plain-text** format: one URL per line,
 *   blank lines and `#` comments skipped, anything not starting with `http` skipped
 * - otherwise the first of `<sitemapindex` / `<urlset` to appear decides the kind, with
 *   namespace prefixes tolerated (`<sm:urlset>`); neither present means the document is
 *   not a sitemap, which reads as an empty `urlset` rather than as an error
 * - `<loc>` is required: a block without one, or with an empty one, is skipped
 * - `<loc>` values are CDATA-unwrapped and entity-decoded — `&amp;` in a query string is
 *   a different URL, and unlike anchor text that difference is not cosmetic. Entities
 *   are decoded inside CDATA too, which XML says they are not: sitemap generators that
 *   reach for CDATA reach for it *instead of* escaping, so the alternative is a literal
 *   `&amp;` in the fetched URL.
 *
 * @example
 * ```ts
 * const result = parseSitemap(`<urlset><url><loc>https://a.com/x</loc></url></urlset>`);
 * if (result.kind === "urlset") result.entries[0].url; // => "https://a.com/x"
 * ```
 */
export function parseSitemap(text: string): SitemapParseResult {
	if (typeof text !== "string" || text === "") return { kind: "urlset", entries: [] };
	if (text.indexOf("<") < 0) return { kind: "urlset", entries: parseText(text) };

	if (detectKind(text) === "sitemapindex") {
		const sitemaps: SitemapIndexEntry[] = [];
		for (const block of blocksOf(text, "sitemap")) {
			const url = fieldOf(block, "loc");
			if (url === undefined) continue;
			const entry: SitemapIndexEntry = { url };
			const lastmod = fieldOf(block, "lastmod");
			if (lastmod !== undefined) entry.lastmod = lastmod;
			sitemaps.push(entry);
			if (sitemaps.length >= MAX_ENTRIES) break;
		}
		return { kind: "sitemapindex", sitemaps };
	}

	const entries: SitemapEntry[] = [];
	for (const block of blocksOf(text, "url")) {
		const url = fieldOf(block, "loc");
		if (url === undefined) continue;
		const entry: SitemapEntry = { url };
		const lastmod = fieldOf(block, "lastmod");
		if (lastmod !== undefined) entry.lastmod = lastmod;
		const changefreq = fieldOf(block, "changefreq");
		if (changefreq !== undefined) entry.changefreq = changefreq;
		const priority = Number.parseFloat(fieldOf(block, "priority") ?? "");
		if (Number.isFinite(priority)) entry.priority = priority;
		entries.push(entry);
		if (entries.length >= MAX_ENTRIES) break;
	}
	return { kind: "urlset", entries };
}

// -----------------------------------------------------------------------------------
// plain text
// -----------------------------------------------------------------------------------

function parseText(text: string): SitemapEntry[] {
	const entries: SitemapEntry[] = [];
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (line === "" || line.charCodeAt(0) === 0x23) continue; // "#"
		if (!/^https?:/i.test(line)) continue;
		entries.push({ url: line });
		if (entries.length >= MAX_ENTRIES) break;
	}
	return entries;
}

// -----------------------------------------------------------------------------------
// the tolerant XML-ish scanner
// -----------------------------------------------------------------------------------

/** Where one element's open tag left off. */
interface OpenTag {
	/** Index of the `<`. */
	start: number;
	/** Index just past the `>`, i.e. where the element's content begins. */
	contentStart: number;
	/** True for `<loc/>`, which has no content to look for. */
	selfClosing: boolean;
}

function isNameStart(c: number): boolean {
	return (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || c === 0x5f;
}

function isNameChar(c: number): boolean {
	return isNameStart(c) || (c >= 0x30 && c <= 0x39) || c === 0x2d || c === 0x2e ||
		c === 0x3a;
}

/** Does this already-lowercased tag name end in `name`, with at most an `ns:` prefix? */
function nameMatches(tagName: string, name: string): boolean {
	if (tagName.length === name.length) return tagName === name;
	return tagName.length > name.length &&
		tagName.charCodeAt(tagName.length - name.length - 1) === 0x3a &&
		tagName.endsWith(name);
}

/**
 * Index of the `>` that ends a tag opening at `from`, or the length of the input when it
 * never arrives. Quote-aware, so an attribute value containing `>` cannot end the tag.
 */
function tagEnd(xml: string, from: number): number {
	let quote = 0;
	for (let k = from; k < xml.length; k++) {
		const c = xml.charCodeAt(k);
		if (quote !== 0) {
			if (c === quote) quote = 0;
			continue;
		}
		if (c === 0x22 || c === 0x27) quote = c;
		else if (c === 0x3e) return k;
	}
	return xml.length;
}

/** The next `<name>` open tag at or after `from`, or `null`. */
function findOpenTag(xml: string, name: string, from: number): OpenTag | null {
	let i = Math.max(0, from);
	while (i < xml.length) {
		const lt = xml.indexOf("<", i);
		if (lt < 0) return null;

		let p = lt + 1;
		if (!isNameStart(xml.charCodeAt(p))) {
			i = lt + 1; // a close tag, a comment, a declaration, or stray text
			continue;
		}
		const nameStart = p;
		while (p < xml.length && isNameChar(xml.charCodeAt(p))) p++;
		const gt = tagEnd(xml, p);

		if (nameMatches(xml.slice(nameStart, p).toLowerCase(), name)) {
			return {
				start: lt,
				contentStart: Math.min(gt + 1, xml.length),
				selfClosing: gt > p && gt < xml.length && xml.charCodeAt(gt - 1) === 0x2f,
			};
		}
		i = gt + 1;
	}
	return null;
}

/** Index of the `<` of the next `</name>` in `[from, limit)`, or `-1`. */
function findCloseTag(xml: string, name: string, from: number, limit: number): number {
	let i = from;
	while (i < limit) {
		const lt = xml.indexOf("</", i);
		if (lt < 0 || lt >= limit) return -1;

		let p = lt + 2;
		const nameStart = p;
		while (p < xml.length && isNameChar(xml.charCodeAt(p))) p++;
		if (nameMatches(xml.slice(nameStart, p).toLowerCase(), name)) return lt;
		i = lt + 2;
	}
	return -1;
}

/**
 * The content of every `<name>…</name>` element, in document order.
 *
 * The close tag is searched for only up to the next open tag of the same name — that
 * bound is what keeps an unclosed-block document linear instead of quadratic, and it
 * costs nothing on a well-formed one, where the close tag always comes first.
 */
function* blocksOf(xml: string, name: string): Generator<string> {
	let pos = 0;
	while (pos < xml.length) {
		const open = findOpenTag(xml, name, pos);
		if (open === null) return;
		if (open.selfClosing) {
			pos = open.contentStart;
			continue;
		}

		const next = findOpenTag(xml, name, open.contentStart);
		const limit = next === null ? xml.length : next.start;
		const close = findCloseTag(xml, name, open.contentStart, limit);

		yield xml.slice(open.contentStart, close < 0 ? limit : close);
		pos = close < 0 ? limit : close + 2;
	}
}

/** The text of the first `<name>` child of a block, or `undefined` when it has none. */
function fieldOf(block: string, name: string): string | undefined {
	const open = findOpenTag(block, name, 0);
	if (open === null || open.selfClosing) return undefined;
	const close = findCloseTag(block, name, open.contentStart, block.length);
	const value = textValue(
		block.slice(open.contentStart, close < 0 ? block.length : close),
	);
	return value === "" ? undefined : value;
}

/** CDATA unwrapped, entities decoded, trimmed. */
function textValue(raw: string): string {
	const text = raw.indexOf("<![CDATA[") < 0 ? raw : unwrapCdata(raw);
	return decodeEntities(text).trim();
}

function unwrapCdata(text: string): string {
	let out = "";
	let i = 0;
	while (i < text.length) {
		const open = text.indexOf("<![CDATA[", i);
		if (open < 0) return out + text.slice(i);
		out += text.slice(i, open);

		const close = text.indexOf("]]>", open + 9);
		if (close < 0) return out + text.slice(open + 9);
		out += text.slice(open + 9, close);
		i = close + 3;
	}
	return out;
}

/** Which root element comes first, if either does. */
function detectKind(xml: string): "urlset" | "sitemapindex" | null {
	const urlset = findOpenTag(xml, "urlset", 0);
	const index = findOpenTag(xml, "sitemapindex", 0);
	if (index === null) return urlset === null ? null : "urlset";
	if (urlset === null) return "sitemapindex";
	return index.start < urlset.start ? "sitemapindex" : "urlset";
}
