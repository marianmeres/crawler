/**
 * Internal — the tolerant HTML scanner every `./extract` parser is built on.
 *
 * There is no DOM here and no tree: a single forward pass over the source that reports
 * where each markup construct starts and ends, and a handful of small helpers for the
 * text between them. That is enough for links, titles and `<meta>` directives, and it
 * is all a crawler can afford — the input is attacker-controlled markup, arriving at
 * whatever size the fetcher allowed.
 *
 * Two rules the whole submodule leans on:
 *
 * 1. **No regex ever runs over the whole document.** Skips are `indexOf`, tag bodies
 *    are matched one bounded slice at a time. A hostile page must not be able to buy
 *    quadratic time with a pathological attribute run.
 * 2. **Every non-text byte is covered by a token.** Comments, doctypes, CDATA,
 *    processing instructions and the raw-text content of `<script>`/`<style>` are all
 *    reported as `kind: "other"`, so {@linkcode textOf} can reconstruct the text of a
 *    fragment by taking exactly the gaps between tokens. Without that, a `<script>`
 *    body inside an `<a>` would read back as anchor text.
 *
 * Nothing here is exported from the package: `@internal`, and pinned by the mod tests.
 *
 * @module
 */

/** One markup construct found by {@linkcode scanTokens}. */
export interface HtmlToken {
	/** `"tag"` for an element open/close tag; `"other"` for everything else. */
	kind: "tag" | "other";
	/** Lowercased element name. `""` when `kind` is `"other"`. */
	name: string;
	/** True for `</x>`. */
	closing: boolean;
	/** True for the XML-ish `<x/>` spelling (never for `<x a=/>`, which is a value). */
	selfClosing: boolean;
	/** Raw source between the element name and the closing `>`, for {@linkcode parseAttrs}. */
	attrsSource: string;
	/** Index of the opening `<`. */
	start: number;
	/** Index just past the closing `>` (or the end of input for an unterminated tag). */
	end: number;
}

/**
 * Elements whose content is text, not markup. An `<a href>` written inside one of these
 * is a string in a program (or a label in a form), never a link — the scanner reports
 * the whole run as one `"other"` token and looks for links again after it.
 *
 * `<noscript>` is deliberately absent: its content *is* markup for a client without
 * scripting, and those links are exactly the ones a crawler wants.
 */
export const RAW_TEXT_TAGS: ReadonlySet<string> = new Set([
	"script",
	"style",
	"title",
	"textarea",
]);

/** Space, tab, LF, FF, CR — HTML's whitespace, which is not JS's `\s`. */
function isHtmlSpace(c: number): boolean {
	return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d;
}

function isNameStart(c: number): boolean {
	return (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a);
}

function isNameChar(c: number): boolean {
	return (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) ||
		(c >= 0x30 && c <= 0x39) || c === 0x2d || c === 0x5f || c === 0x3a ||
		c === 0x2e;
}

/** Case-insensitive comparison of an already-lowercase `name` against `html` at `pos`. */
function matchesNameAt(html: string, pos: number, name: string): boolean {
	if (pos + name.length > html.length) return false;
	for (let k = 0; k < name.length; k++) {
		let c = html.charCodeAt(pos + k);
		if (c >= 0x41 && c <= 0x5a) c += 32;
		if (c !== name.charCodeAt(k)) return false;
	}
	return true;
}

/**
 * Index of the `<` of the next `</name` close tag, or `-1`. Bounded by `limit` so
 * callers can search a window rather than the rest of the document.
 *
 * The scan is hand-written rather than `html.indexOf("</", k)`, and that is the whole
 * point of it: `indexOf` takes no end argument, so it searches to the end of the
 * document and `limit` only gets to reject the answer *afterwards*. That made the
 * window a lie — {@linkcode "./extract-links.ts".extractLinks} calls this once per
 * `<a>`, so a page whose anchors are never closed cost O(links x document): measured
 * 47 s of blocked event loop on 1.3 MB of markup, against 12 ms for the same page with
 * its anchors closed. Same class as the two other unbounded scans this package has had
 * to hand-write.
 *
 * The cost is that the unbounded call (the raw-text skip in {@linkcode scanTokens})
 * gives up `indexOf`'s SIMD search — ~85 ms instead of ~2 ms on a 16 MB document,
 * once. That is a trade worth making for one predictable code path in the function
 * every link on the page goes through.
 */
export function findCloseTagIndex(
	html: string,
	name: string,
	from: number,
	limit: number = html.length,
): number {
	const end = Math.min(limit, html.length);
	for (let k = Math.max(0, from); k < end; k++) {
		// charCodeAt past the end is NaN, so the `/` test fails on its own
		if (html.charCodeAt(k) !== 0x3c || html.charCodeAt(k + 1) !== 0x2f) continue;
		if (matchesNameAt(html, k + 2, name)) {
			// "</abbr>" must not close "<a>" — the name has to end here
			if (!isNameChar(html.charCodeAt(k + 2 + name.length))) return k;
		}
	}
	return -1;
}

function other(start: number, end: number): HtmlToken {
	return {
		kind: "other",
		name: "",
		closing: false,
		selfClosing: false,
		attrsSource: "",
		start,
		end,
	};
}

/**
 * Walk `html` once, yielding every markup construct in source order.
 *
 * Tolerances, all of them deliberate and all of them what a browser does:
 *
 * - a `<` that does not begin a tag (`a < b`, `<3`, `</>`) is text, not a token
 * - an unterminated tag at EOF is still reported, with `end` at the end of input —
 *   browsers drop it, we would rather see the href
 * - a `>` inside a quoted attribute value does not end the tag; a quote is only a
 *   quote where a value can start, so `<a href=a"b>` cannot swallow the document
 * - an unclosed `<script>`/`<style>`/`<title>` swallows the rest of the input, exactly
 *   as it does in a browser — extracting `href=` out of unterminated JavaScript would
 *   invent links that no reader can see
 */
export function* scanTokens(html: string): Generator<HtmlToken> {
	const len = html.length;
	let i = 0;

	while (i < len) {
		const lt = html.indexOf("<", i);
		if (lt < 0) return;

		if (html.startsWith("<!--", lt)) {
			const e = html.indexOf("-->", lt + 4);
			const end = e < 0 ? len : e + 3;
			yield other(lt, end);
			i = end;
			continue;
		}

		if (html.startsWith("<![CDATA[", lt)) {
			const e = html.indexOf("]]>", lt + 9);
			const end = e < 0 ? len : e + 3;
			yield other(lt, end);
			i = end;
			continue;
		}

		const next = html.charCodeAt(lt + 1);
		// doctype, bogus comment, processing instruction
		if (next === 0x21 || next === 0x3f) {
			const e = html.indexOf(">", lt + 2);
			const end = e < 0 ? len : e + 1;
			yield other(lt, end);
			i = end;
			continue;
		}

		const closing = next === 0x2f;
		let p = lt + (closing ? 2 : 1);
		if (!isNameStart(html.charCodeAt(p))) {
			i = lt + 1; // stray "<" — text
			continue;
		}

		const nameStart = p;
		while (p < len && isNameChar(html.charCodeAt(p))) p++;
		const name = html.slice(nameStart, p).toLowerCase();

		// Find the `>` that ends the tag. The states are the HTML tokenizer's, minus
		// everything that does not change where the tag ends.
		const IN_TAG = 0, AFTER_EQ = 1, UNQUOTED = 2, QUOTED = 3;
		let state = IN_TAG;
		let quote = 0;
		let selfClosing = false;
		let gt = p;
		for (; gt < len; gt++) {
			const c = html.charCodeAt(gt);
			if (state === QUOTED) {
				if (c === quote) state = IN_TAG;
				continue;
			}
			if (c === 0x3e) break; // ">"
			if (isHtmlSpace(c)) {
				if (state === UNQUOTED) state = IN_TAG;
				continue; // AFTER_EQ tolerates `href = "x"`
			}
			if (state === AFTER_EQ) {
				if (c === 0x22 || c === 0x27) {
					quote = c;
					state = QUOTED;
				} else {
					state = UNQUOTED;
				}
				selfClosing = false;
				continue;
			}
			if (state === UNQUOTED) continue; // a "/" here belongs to the value
			if (c === 0x3d) { // "="
				state = AFTER_EQ;
				selfClosing = false;
				continue;
			}
			selfClosing = c === 0x2f; // "/", and only if nothing follows it
		}

		const end = gt < len ? gt + 1 : len;
		yield {
			kind: "tag",
			name,
			closing,
			selfClosing,
			attrsSource: html.slice(p, gt),
			start: lt,
			end,
		};
		i = end;

		if (!closing && !selfClosing && RAW_TEXT_TAGS.has(name)) {
			const close = findCloseTagIndex(html, name, i);
			const stop = close < 0 ? len : close;
			if (stop > i) yield other(i, stop);
			i = stop;
		}
	}
}

// Names may not contain whitespace, quotes, ">", "/" or "="; values are quoted with
// either quote or unquoted up to whitespace or ">". Runs over one tag body at a time.
const ATTR_RE = /([^\s"'>/=]+)\s*(?:=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g;

/**
 * Attributes of a tag body, lowercased, entity-decoded and unquoted.
 *
 * First occurrence wins (`<a href=a href=b>` is `a`, as in every browser), a valueless
 * attribute maps to `""`, an unterminated quoted value keeps whatever text it had, and
 * the result is a `Map` rather than an object so that an attribute literally named
 * `__proto__` cannot reach an object prototype.
 */
export function parseAttrs(attrsSource: string): Map<string, string> {
	const out = new Map<string, string>();
	if (!attrsSource) return out;

	ATTR_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = ATTR_RE.exec(attrsSource)) !== null) {
		const name = m[1].toLowerCase();
		if (out.has(name)) continue;
		let value = m[2] ?? "";
		const q = value.charCodeAt(0);
		if (q === 0x22 || q === 0x27) {
			// a value whose closing quote never arrived (the tag ran into EOF) is the
			// text after the quote, not the quote itself
			value = value.length > 1 && value.charCodeAt(value.length - 1) === q
				? value.slice(1, -1)
				: value.slice(1);
		}
		out.set(name, decodeEntities(value));
	}
	return out;
}

// A Map, not an object literal: `&constructor;` must decode to nothing, not to
// `Object.prototype.constructor`.
const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map([
	["amp", "&"],
	["lt", "<"],
	["gt", ">"],
	["quot", '"'],
	["apos", "'"],
	["nbsp", "\u00a0"],
]);

/** The body between `&` and `;`, decoded — or `undefined` when we do not know it. */
function decodeOne(body: string): string | undefined {
	if (body === "") return undefined;

	if (body.charCodeAt(0) === 0x23) { // "#"
		const hex = body.charCodeAt(1) === 0x78 || body.charCodeAt(1) === 0x58;
		const digits = body.slice(hex ? 2 : 1);
		if (digits === "") return undefined;
		if (!(hex ? /^[0-9a-f]+$/i : /^[0-9]+$/).test(digits)) return undefined;
		const cp = parseInt(digits, hex ? 16 : 10);
		// NUL, lone surrogates and out-of-range values are not characters
		if (!(cp > 0) || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
			return undefined;
		}
		return String.fromCodePoint(cp);
	}

	// `&AMP;` is as legal as `&amp;`; the rest of HTML's 2000+ named entities are not
	// worth the table for a crawler, and an undecoded one stays verbatim.
	return NAMED_ENTITIES.get(body.toLowerCase());
}

/** The longest entity we decode is `&#x10FFFF;` — 10 chars, `;` included. */
const MAX_ENTITY_LENGTH = 12;

/**
 * Index of the `;` that could close an entity opening at `amp`, or `-1`.
 *
 * The search is bounded by {@linkcode MAX_ENTITY_LENGTH}, and that bound is the whole
 * point: a plain `text.indexOf(";", amp + 1)` scans to the end of the document for
 * every `&` that is not an entity, which makes a query string of 200 000 bare
 * ampersands quadratic — seconds of blocked event loop, from an `href` any site can
 * serve. Anything past the bound was going to be rejected anyway.
 */
function entityEnd(text: string, amp: number): number {
	const limit = Math.min(text.length, amp + 1 + MAX_ENTITY_LENGTH);
	for (let k = amp + 1; k < limit; k++) {
		if (text.charCodeAt(k) === 0x3b) return k; // ";"
	}
	return -1;
}

/**
 * Decode the handful of HTML entities that actually matter to a crawler: the five
 * XML-ish names, `&nbsp;`, and numeric references. Everything else is left verbatim —
 * an undecoded `&hellip;` in anchor text is cosmetic, while a wrong `&amp;` in an href
 * is a different URL.
 */
export function decodeEntities(text: string): string {
	if (text.indexOf("&") < 0) return text;

	let out = "";
	let i = 0;
	while (i < text.length) {
		const amp = text.indexOf("&", i);
		if (amp < 0) {
			out += text.slice(i);
			return out;
		}
		out += text.slice(i, amp);

		const semi = entityEnd(text, amp);
		const decoded = semi < 0 ? undefined : decodeOne(text.slice(amp + 1, semi));

		if (decoded === undefined) {
			out += "&";
			i = amp + 1;
		} else {
			out += decoded;
			i = semi + 1;
		}
	}
	return out;
}

/** Squash every whitespace run (`&nbsp;` included, post-decode) to one space, trimmed. */
export function collapseWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/**
 * The text of a *fragment*: everything not inside a tag, a comment, or a raw-text
 * element. Intended for small slices — an anchor's content, a `<title>` — not for the
 * whole document.
 */
export function textOf(fragment: string): string {
	let out = "";
	let pos = 0;
	for (const token of scanTokens(fragment)) {
		if (token.start > pos) out += fragment.slice(pos, token.start);
		pos = token.end;
	}
	if (pos < fragment.length) out += fragment.slice(pos);
	return out;
}
