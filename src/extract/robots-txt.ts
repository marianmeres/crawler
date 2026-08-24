/**
 * robots.txt: parsing, and the path matcher that answers "may I fetch this?".
 *
 * This module is the *parser* only. Fetching robots.txt, caching one per origin, and the
 * 4xx-means-allow / 5xx-means-disallow policy belong to the crawl loop — which is why
 * {@linkcode robotsAllowAll} and {@linkcode robotsDisallowAll} ship here as the two
 * values that policy needs.
 *
 * @module
 */

/** One `Allow:` / `Disallow:` line. */
export interface RobotsRule {
	allow: boolean;
	/** The path pattern as written (trimmed), e.g. `/private*`, `/*.pdf$`. */
	pattern: string;
}

/** One `User-agent:` block and the rules that follow it. */
export interface RobotsGroup {
	/** Lowercased user-agent tokens this group addresses; `"*"` is possible. */
	userAgents: string[];
	rules: RobotsRule[];
	/** `Crawl-delay` in seconds; `undefined` when absent or unparsable. */
	crawlDelay?: number;
}

/** A parsed robots.txt, with the matcher bound to it. */
export interface RobotsTxt {
	/**
	 * The groups in source order, for inspection. Rule matching is compiled lazily on
	 * the first {@linkcode RobotsTxt.isAllowed} call and memoized per user agent, so
	 * mutating this array afterwards is not reflected in the answers.
	 */
	groups: RobotsGroup[];
	/** `Sitemap:` values as written — absolute per spec, so the caller resolves. */
	sitemaps: string[];
	/**
	 * May `pathAndQuery` be fetched by `userAgent`?
	 *
	 * `pathAndQuery` is `url.pathname + url.search`, percent-encoded exactly as it will
	 * be requested — matching is byte-wise and case-sensitive (RFC 9309 compares octets,
	 * so `/A` and `/a` are different paths, and `%2F` is not `/`). A whole URL is
	 * accepted too and reduced to its path and query, because passing one is the obvious
	 * mistake and silently answering "allowed" for everything would be the worst way to
	 * report it.
	 *
	 * Precedence: the longest matching pattern wins; on equal length `Allow` wins; with
	 * no matching rule the answer is `true`.
	 */
	isAllowed(pathAndQuery: string, userAgent: string): boolean;
	/** `Crawl-delay` (seconds) for `userAgent`, honoring the same group selection. */
	crawlDelay(userAgent: string): number | undefined;
}

/** Lines past this are ignored — a robots.txt is not a data feed. */
const MAX_LINES = 10_000;

/** Patterns longer than this are ignored. */
const MAX_PATTERN_LENGTH = 2_000;

/** Distinct user agents we keep group-selection results for. */
const MAX_MEMO_SIZE = 64;

const ABSOLUTE_URL_RE = /^[a-z][a-z0-9+.-]*:/i;

/** A rule with its trailing `$` split off — all the "compilation" the matcher needs. */
interface CompiledRule {
	allow: boolean;
	/** Pattern length as written, which is what precedence is measured on. */
	length: number;
	/** Pattern body, `$` removed. `*` is the only metacharacter left. */
	body: string;
	/** The pattern ended in `$`: it must match the whole path, not just a prefix. */
	anchored: boolean;
}

interface Selection {
	rules: CompiledRule[];
	crawlDelay?: number;
}

/**
 * Glob match, hand-written on purpose.
 *
 * The obvious implementation compiles each pattern to a regex with `*` → `[\s\S]*`, and
 * it is a denial-of-service waiting to happen: any site can serve
 * `Disallow: /a*a*a*a*a*a*a*a*b`, and a backtracking engine then explores every way to
 * split a long path between those stars before reporting no match. This two-pointer
 * matcher is O(pattern × path) in the worst case and linear in practice, and it needs no
 * escaping pass — a `(` or `+` in a path is just a character.
 *
 * `anchored` is the trailing-`$` case: the pattern must consume the whole path rather
 * than a prefix of it.
 */
function globMatch(body: string, path: string, anchored: boolean): boolean {
	const pl = body.length;
	const tl = path.length;
	let p = 0;
	let t = 0;
	let star = -1;
	let mark = 0;

	for (;;) {
		if (p === pl && !anchored) return true; // pattern consumed — prefix matched
		if (t === tl) {
			while (p < pl && body.charCodeAt(p) === 0x2a) p++;
			return p === pl;
		}
		if (p < pl && body.charCodeAt(p) === 0x2a) {
			star = p++;
			mark = t;
			continue;
		}
		if (p < pl && body.charCodeAt(p) === path.charCodeAt(t)) {
			p++;
			t++;
			continue;
		}
		if (star >= 0) {
			p = star + 1;
			t = ++mark;
			continue;
		}
		return false;
	}
}

function compile(rule: RobotsRule): CompiledRule {
	const anchored = rule.pattern.endsWith("$");
	return {
		allow: rule.allow,
		length: rule.pattern.length,
		body: anchored ? rule.pattern.slice(0, -1) : rule.pattern,
		anchored,
	};
}

/** `url.pathname + url.search`, from whatever the caller actually passed. */
function targetOf(pathAndQuery: string): string {
	if (typeof pathAndQuery !== "string" || pathAndQuery === "") return "/";

	let target = pathAndQuery;
	if (target.charCodeAt(0) !== 0x2f) {
		if (ABSOLUTE_URL_RE.test(target)) {
			try {
				const url = new URL(target);
				target = url.pathname + url.search;
			} catch {
				target = "/" + target;
			}
		} else {
			target = "/" + target;
		}
	}

	// a fragment is never sent to the server, so it is not part of the decision
	const hash = target.indexOf("#");
	return hash < 0 ? target : target.slice(0, hash);
}

/**
 * The groups addressing `userAgent`: the ones whose longest matching token is longest
 * overall, else every `*` group, else none.
 *
 * Several groups can win together — a robots.txt that names the same agent twice is
 * malformed but common, and RFC 9309 says to treat those rules as one set rather than
 * silently obeying half of them.
 */
function selectGroups(groups: RobotsGroup[], userAgent: string): RobotsGroup[] {
	const ua = (typeof userAgent === "string" ? userAgent : "").toLowerCase();
	let best = -1;
	let selected: RobotsGroup[] = [];

	for (const group of groups) {
		let longest = -1;
		for (const token of group.userAgents) {
			if (token === "" || token === "*") continue;
			if (token.length > longest && ua.includes(token)) longest = token.length;
		}
		if (longest < 0) continue;
		if (longest > best) {
			best = longest;
			selected = [group];
		} else if (longest === best) {
			selected.push(group);
		}
	}

	if (selected.length > 0) return selected;
	return groups.filter((group) => group.userAgents.includes("*"));
}

/** Wrap parsed groups in the matcher, with the lazy compile + per-UA memo. */
function build(groups: RobotsGroup[], sitemaps: string[]): RobotsTxt {
	const compiled = new Map<RobotsGroup, CompiledRule[]>();
	const memo = new Map<string, Selection>();

	const selectionFor = (userAgent: string): Selection => {
		const key = typeof userAgent === "string" ? userAgent : "";
		const hit = memo.get(key);
		if (hit) return hit;

		const rules: CompiledRule[] = [];
		let crawlDelay: number | undefined;
		for (const group of selectGroups(groups, key)) {
			let groupRules = compiled.get(group);
			if (!groupRules) {
				groupRules = group.rules.map(compile);
				compiled.set(group, groupRules);
			}
			// a loop, not push(...spread) — a hostile file can hold 10k rules
			for (const rule of groupRules) rules.push(rule);
			// several groups for one agent: the most patient delay wins — being
			// slower than asked is never a violation
			if (
				group.crawlDelay !== undefined &&
				(crawlDelay === undefined || group.crawlDelay > crawlDelay)
			) {
				crawlDelay = group.crawlDelay;
			}
		}

		const selection: Selection = { rules, crawlDelay };
		if (memo.size >= MAX_MEMO_SIZE) memo.clear();
		memo.set(key, selection);
		return selection;
	};

	return {
		groups,
		sitemaps,
		isAllowed(pathAndQuery: string, userAgent: string): boolean {
			const target = targetOf(pathAndQuery);
			let best: CompiledRule | undefined;
			for (const rule of selectionFor(userAgent).rules) {
				// a shorter pattern can never win, so do not even match it
				if (best !== undefined && rule.length < best.length) continue;
				if (!globMatch(rule.body, target, rule.anchored)) continue;
				if (
					best === undefined || rule.length > best.length ||
					rule.allow
				) {
					best = rule;
				}
			}
			return best === undefined ? true : best.allow;
		},
		crawlDelay(userAgent: string): number | undefined {
			return selectionFor(userAgent).crawlDelay;
		},
	};
}

/**
 * Parse a robots.txt document. Never throws: anything unrecognized is ignored, and the
 * worst case is a `RobotsTxt` with no groups, which allows everything.
 *
 * The grammar, as implemented:
 *
 * - a BOM is stripped, lines split on `\r?\n`, `#` starts a comment, the directive name
 *   is everything before the FIRST colon (so a `Sitemap:` URL survives intact)
 * - consecutive `User-agent:` lines open ONE group (RFC 9309); a rule line appearing
 *   before any `User-agent` opens an implicit `*` group
 * - `Disallow:` / `Allow:` with an empty value contribute nothing at all — an empty
 *   `Disallow` is the documented way to say "everything is allowed", and an empty
 *   `Allow` that matched everything would quietly cancel the rest of the file
 * - `Sitemap:` is global, wherever it appears; the value is kept verbatim
 * - unknown directives are ignored, as are lines with no colon
 *
 * Against hostile input: lines past 10 000 and patterns longer than 2 000 characters are
 * ignored (the document size itself is capped upstream by the fetch).
 *
 * @example
 * ```ts
 * const robots = parseRobotsTxt(`
 *     User-agent: *
 *     Disallow: /private
 *     Allow: /private/public
 * `);
 * robots.isAllowed("/private/x", "mybot");      // => false
 * robots.isAllowed("/private/public/x", "mybot"); // => true (longer pattern wins)
 * ```
 */
export function parseRobotsTxt(text: string): RobotsTxt {
	const groups: RobotsGroup[] = [];
	const sitemaps: string[] = [];
	if (typeof text !== "string" || text === "") return build(groups, sitemaps);

	const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
	let current: RobotsGroup | undefined;
	// whether the group being built is still collecting `User-agent:` lines
	let collectingAgents = false;
	let lines = 0;

	const ensureGroup = (): RobotsGroup => {
		if (current === undefined) {
			current = { userAgents: ["*"], rules: [] };
			groups.push(current);
		}
		collectingAgents = false;
		return current;
	};

	for (const raw of source.split(/\r?\n/)) {
		if (++lines > MAX_LINES) break;

		const hash = raw.indexOf("#");
		const line = (hash < 0 ? raw : raw.slice(0, hash)).trim();
		if (line === "") continue;

		const colon = line.indexOf(":");
		if (colon < 0) continue;
		const directive = line.slice(0, colon).trim().toLowerCase();
		const value = line.slice(colon + 1).trim();

		switch (directive) {
			case "user-agent": {
				if (value === "") break;
				if (current === undefined || !collectingAgents) {
					current = { userAgents: [], rules: [] };
					groups.push(current);
					collectingAgents = true;
				}
				current.userAgents.push(value.toLowerCase());
				break;
			}
			case "allow":
			case "disallow": {
				const group = ensureGroup();
				if (value === "" || value.length > MAX_PATTERN_LENGTH) break;
				group.rules.push({ allow: directive === "allow", pattern: value });
				break;
			}
			case "crawl-delay": {
				const group = ensureGroup();
				const seconds = Number.parseFloat(value);
				if (
					group.crawlDelay === undefined && Number.isFinite(seconds) &&
					seconds >= 0
				) {
					group.crawlDelay = seconds;
				}
				break;
			}
			case "sitemap": {
				if (value !== "") sitemaps.push(value);
				break;
			}
				// everything else (Host:, Clean-param:, typos) is ignored
		}
	}

	return build(groups, sitemaps);
}

/**
 * Everything allowed — the value the crawl loop uses when robots.txt is missing, 4xx, or
 * unfetchable. A fresh object each call, because a `RobotsTxt` carries memo state.
 */
export function robotsAllowAll(): RobotsTxt {
	return build([], []);
}

/**
 * Everything disallowed — the value for a 5xx robots.txt, where the polite reading of "I
 * cannot tell you my rules right now" is to stay away.
 */
export function robotsDisallowAll(): RobotsTxt {
	return build([{ userAgents: ["*"], rules: [{ allow: false, pattern: "/" }] }], []);
}
