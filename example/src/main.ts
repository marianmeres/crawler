/// <reference no-default-lib="true" />
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/// <reference lib="esnext" />
/**
 * Example app for `@marianmeres/crawler`.
 *
 * Seeds and budgets go up, and what comes back is a live view of one crawl: the counters
 * from `CrawlStats`, the pages as they land, and the link graph with the reason every
 * skipped edge was skipped.
 *
 * The crawl itself runs in `example/server.ts` — a browser cannot run one (CORS, no
 * robots.txt, and a crawl outlives the page that started it). So this file is pure UI. It
 * posts the options, then polls, and the crucial detail is *what* it polls: not the
 * runner, but the crawler's own PostgreSQL tables. That is why the `direct` and `queued`
 * runners share every line of the rendering below, and why job mode can show live
 * progress at all — steve writes a job's `result` exactly once, at the end.
 *
 * Built with `@marianmeres/vanilla`: explicit reactive state (`observable`), markup in
 * `<template>`s (`fromTemplate` / `refs`), one delegated listener tree (`delegate`).
 *
 * This is browser code: the triple-slash lib references above type it against the DOM
 * (the repo's `deno.json` targets the Deno runtime for the library itself).
 *
 * Bundle with: `deno task example:build` (→ `example/dist/bundle.js`).
 */
import {
	createView,
	delegate,
	fromTemplate,
	observable,
	refs,
} from "@marianmeres/vanilla";
import { VERSION } from "./version.generated.ts";

/* ---- config --------------------------------------------------------------- */

/** Must match the literal in the anti-FOUC inline script in index.html. */
const THEME_KEY = "crawler-example-theme";

/** How often to ask the server how it is going. */
const POLL_MS = 800;

/**
 * Rows kept in the DOM per table. The counters report the real totals; this only bounds
 * what is painted, because a 300-page crawl can produce tens of thousands of edges.
 */
const RENDER_CAP = 500;

const MODE_HINT: Record<string, string> = {
	direct:
		"The server owns the crawl: createCrawler() streams pages, the ./pg handle persists each one. Dies with the process.",
	queued:
		"One crawl = one @marianmeres/steve job, run by an in-process worker. Durable and retried — and it waits its turn.",
};

/* ---- the wire ------------------------------------------------------------- */

type Mode = "direct" | "queue";

interface PageRow {
	url: string;
	finalUrl: string | null;
	depth: number;
	status: number | null;
	ok: boolean;
	notModified: boolean;
	contentType: string | null;
	title: string | null;
	size: number | null;
	timing: Record<string, number>;
	errorKind: string | null;
	errorMessage: string | null;
	skipReason: string | null;
	/** Whatever `onPage` returned — here, the crawl-time html-extract summary. */
	data: Record<string, unknown> | null;
}

interface LinkRow {
	fromUrl: string;
	toUrl: string;
	kind: "internal" | "external";
	rel: string;
	nofollow: boolean;
	followed: boolean;
	skipReason: string | null;
}

interface Stats {
	done?: number;
	failed?: number;
	skipped?: number;
	queued?: number;
	inFlight?: number;
	bytes?: number;
	elapsed?: number;
	pagesPerSecond?: number;
	eta?: number;
}

interface Snapshot {
	mode: Mode;
	uid: string;
	job: { status: string; attempts: number; error: string | null } | null;
	crawl: null | {
		uid: string;
		seeds: string[];
		status: string;
		stats: Stats;
		options: Record<string, unknown>;
		stoppedBy: string | null;
		error: string | null;
		startedAt: string | null;
		endedAt: string | null;
	};
	pages: PageRow[];
	links: LinkRow[];
	terminal: boolean;
	more: boolean;
	stoppable: boolean;
	error?: string;
}

/** `@marianmeres/html-extract`'s document, JSON-round-tripped (the lazy bits materialized). */
interface Doc {
	title?: string;
	lang?: string;
	metadata: Record<string, unknown>;
	jsonLd: unknown[];
	embeddedJson: Record<string, unknown>;
	microdata: unknown[];
	content: null | {
		html: string;
		markdown: string;
		text: string;
		textLength: number;
		linkDensity: number;
		via: string;
	};
}

interface PageDoc {
	html: string | null;
	bytes: number;
	truncated: boolean;
	contentType: string | null;
	charset: string | null;
	fetchedAt: string | null;
	doc: Doc | null;
	error?: string;
}

interface Capabilities {
	browser: boolean;
	allowImpolite: boolean;
	caps: Record<string, unknown>;
}

interface RecentRow {
	uid: string;
	jobUid: string | null;
	seeds: string[];
	status: string;
	stoppedBy: string | null;
	stats: Stats;
	createdAt: string;
}

/* ---- state ---------------------------------------------------------------- */

/** Bumped on every start/attach; a poll belonging to an older run just stops. */
let session = 0;

const recent = observable<RecentRow[]>([]);

/* ---- theme (page-level, class-based: matches the design-tokens `.dark`) ----
 * The class is set pre-paint by the inline script in index.html; this keeps it
 * and the browser chrome color (<meta name="theme-color">) in sync afterwards. */

const prefersDark = (): boolean =>
	globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;

const applyTheme = (dark: boolean): void => {
	const root = document.documentElement;
	root.classList.toggle("dark", dark);
	const bg = getComputedStyle(root).getPropertyValue("--stuic-color-background").trim();
	if (bg) {
		document.querySelector('meta[name="theme-color"]')?.setAttribute("content", bg);
	}
};

let isDark = (() => {
	const stored = localStorage.getItem(THEME_KEY);
	return stored ? stored === "dark" : prefersDark();
})();
applyTheme(isDark);

/* ---- utils ---------------------------------------------------------------- */

const nf = new Intl.NumberFormat();

const bytes = (n: number): string =>
	n < 1024
		? `${n} B`
		: n < 1024 * 1024
		? `${(n / 1024).toFixed(1)} KB`
		: `${(n / 1024 / 1024).toFixed(2)} MB`;

const secs = (ms: number): string => {
	const s = Math.round(ms / 1000);
	return s < 60
		? `${s}s`
		: `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
};

/**
 * `https://a.com/b/c?d` → `/b/c?d`, so the column reads as a site map rather than noise.
 *
 * Only for `home` — the origin the crawl was seeded from. A crawl routinely spans more
 * than one: a site behind a TLS-terminating proxy redirects every `https:` page to its
 * `http:` twin, and those are two different URLs the crawler is right to keep apart.
 * Hiding the origin there would render them as two identical-looking rows, which reads
 * as a dedup bug in the crawler rather than as what it is.
 */
const short = (url: string, home?: string): string => {
	try {
		const u = new URL(url);
		const path = (u.pathname + u.search) || "/";
		return home !== undefined && u.origin !== home ? u.origin + path : path;
	} catch {
		return url;
	}
};

const host = (url: string): string => {
	try {
		return new URL(url).host;
	} catch {
		return "";
	}
};

const originOf = (url: string): string | undefined => {
	try {
		return new URL(url).origin;
	} catch {
		return undefined;
	}
};

/** A `<dt>/<dd>` pair appended to a `dl.kv`. Skips nothing — an empty value is a fact. */
function kv(list: HTMLElement, k: string, v: unknown): void {
	const dt = document.createElement("dt");
	dt.textContent = k;
	const dd = document.createElement("dd");
	dd.textContent = v === null || v === undefined || v === ""
		? "—"
		: typeof v === "number"
		? nf.format(v)
		: String(v);
	list.append(dt, dd);
}

/**
 * Inject a `<base>` so the archived DOM's relative CSS, images and fonts resolve against
 * the origin it came from rather than against `about:srcdoc`, where they all 404.
 */
function withBase(html: string, url: string): string {
	const base = `<base href="${url.replace(/"/g, "&quot;")}">`;
	return /<head[^>]*>/i.test(html)
		? html.replace(/<head[^>]*>/i, (open) => open + base)
		: base + html;
}

/** Prepend `rows` (which arrive oldest-first) and trim the tail back to the cap. */
function prepend(body: HTMLElement, nodes: HTMLElement[]): void {
	if (!nodes.length) return;
	const frag = document.createDocumentFragment();
	// newest at the top: the arrival order is what a live feed wants reversed
	for (let i = nodes.length - 1; i >= 0; i--) frag.appendChild(nodes[i]);
	body.prepend(frag);
	while (body.childElementCount > RENDER_CAP) body.lastElementChild!.remove();
}

/* ---- view ----------------------------------------------------------------- */

const app = createView((track) => {
	const el = fromTemplate("tpl-app");
	const r = refs(el);

	const form = r.form as HTMLFormElement;
	const startBtn = r.startBtn as HTMLButtonElement;
	const stopBtn = r.stopBtn as HTMLButtonElement;

	/** What is on screen right now, so Stop and the broken report know their target. */
	let current: { mode: Mode; uid: string } | null = null;
	let cursors = { pages: 0, links: 0 };
	/** Origin of the run's first seed — what `short()` is allowed to leave off. */
	let home: string | undefined;
	let totals = { pages: 0, links: 0 };
	let brokenLoaded = false;
	let timer: ReturnType<typeof setTimeout> | undefined;

	/* -- the form -- */

	const val = (name: string): string => (r[name] as HTMLInputElement).value.trim();
	const int = (name: string, fallback: number): number => {
		const n = Number(val(name));
		return Number.isFinite(n) ? n : fallback;
	};
	const on = (name: string): boolean => (r[name] as HTMLInputElement).checked;

	const readForm = () => ({
		seeds: (r.seeds as HTMLTextAreaElement).value
			.split(/[\s,]+/)
			.map((s) => s.trim())
			.filter(Boolean),
		mode: (r.modeQueue as HTMLInputElement).checked ? "queue" : "direct",
		maxDepth: int("maxDepth", 2),
		maxPages: int("maxPages", 50),
		maxDuration: int("maxDuration", 120) * 1000,
		concurrency: int("concurrency", 4),
		perHostDelay: int("perHostDelay", 250),
		subdomains: (r.subdomains as HTMLSelectElement).value,
		allowExternal: on("allowExternal"),
		checkExternal: on("checkExternal"),
		assets: on("assets"),
		sitemaps: on("sitemaps"),
		stripTrailingSlash: on("stripTrailingSlash"),
		stripWww: on("stripWww"),
		respectRobots: on("respectRobots"),
		persistBody: on("persistBody"),
		js: on("js"),
	});

	const setDefaults = (): void => {
		(r.seeds as HTMLTextAreaElement).value = "https://emde.meres.sk";
		(r.maxDepth as HTMLInputElement).value = "2";
		(r.maxPages as HTMLInputElement).value = "50";
		(r.maxDuration as HTMLInputElement).value = "120";
		(r.concurrency as HTMLInputElement).value = "4";
		(r.perHostDelay as HTMLInputElement).value = "250";
	};

	const syncModeHint = (): void => {
		const queued = (r.modeQueue as HTMLInputElement).checked;
		r.modeHint.textContent = MODE_HINT[queued ? "queued" : "direct"];
	};

	/* -- rendering -- */

	const setBadge = (node: HTMLElement, text: string, kind = ""): void => {
		node.hidden = false;
		node.textContent = text;
		node.className = `badge${kind ? ` badge-${kind}` : ""}`;
	};

	const statusKind = (status: string): string =>
		status === "completed"
			? "ok"
			: status === "running"
			? "run"
			: status === "failed" || status === "expired"
			? "bad"
			: status === "stopped"
			? "warn"
			: "";

	const reset = (): void => {
		closeModal();
		byUrl.clear();
		home = undefined;
		cursors = { pages: 0, links: 0 };
		totals = { pages: 0, links: 0 };
		brokenLoaded = false;
		r.pagesBody.replaceChildren();
		r.linksBody.replaceChildren();
		r.brokenBody.replaceChildren();
		r.cPages.textContent = "0";
		r.cLinks.textContent = "0";
		r.cBroken.textContent = "—";
		r.pagesNote.textContent = "";
		r.linksNote.textContent = "";
		r.pagesEmpty.hidden = false;
		r.linksEmpty.hidden = false;
		r.brokenEmpty.hidden = false;
		r.jobBadge.hidden = true;
		r.stoppedBadge.hidden = true;
		r.errorBox.hidden = true;
		r.notes.hidden = true;
		r.elapsed.textContent = "";
		for (const k of ["tDone", "tFailed", "tSkipped", "tQueued", "tFlight"]) {
			r[k].textContent = "0";
		}
		r.tBytes.textContent = "0 B";
		r.tRate.textContent = "0";
		r.tEta.textContent = "—";
		(r.barFill as HTMLElement).style.width = "0%";
		r.bar.classList.remove("indeterminate", "is-done", "is-halted");
	};

	const renderStats = (snap: Snapshot): void => {
		const s = snap.crawl?.stats ?? {};
		r.tDone.textContent = nf.format(s.done ?? 0);
		r.tFailed.textContent = nf.format(s.failed ?? 0);
		r.tSkipped.textContent = nf.format(s.skipped ?? 0);
		r.tQueued.textContent = nf.format(s.queued ?? 0);
		r.tFlight.textContent = nf.format(s.inFlight ?? 0);
		r.tBytes.textContent = bytes(s.bytes ?? 0);
		r.tRate.textContent = (s.pagesPerSecond ?? 0).toFixed(1);
		r.tEta.textContent = s.eta == null || snap.terminal ? "—" : secs(s.eta);
		r.elapsed.textContent = s.elapsed ? secs(s.elapsed) : "";

		// the budget is the honest denominator — it is the number the crawl will stop at.
		// A crawl that ran out of site rather than out of budget is 100% done at 24/40,
		// so `completed` fills the bar; anything else keeps the ratio it really reached.
		const budget = Number(snap.crawl?.options?.maxPages ?? 0);
		const fetched = (s.done ?? 0) + (s.failed ?? 0);
		const finished = snap.terminal && snap.crawl?.stoppedBy === "completed";
		const bar = r.bar as HTMLElement;
		const fill = r.barFill as HTMLElement;
		if (finished) {
			bar.classList.remove("indeterminate");
			fill.style.width = "100%";
		} else if (budget > 0) {
			bar.classList.remove("indeterminate");
			fill.style.width = `${Math.min(100, (fetched / budget) * 100).toFixed(1)}%`;
		} else {
			bar.classList.toggle("indeterminate", !snap.terminal);
		}
		bar.classList.toggle("is-done", finished);
		bar.classList.toggle("is-halted", snap.terminal && !finished);
	};

	const renderPages = (rows: PageRow[]): void => {
		if (!rows.length) return;
		r.pagesEmpty.hidden = true;
		const nodes = rows.map((p) => {
			const node = fromTemplate("tpl-page-row");
			const q = refs(node);
			// the row IS the handle: the modal needs the PageRow it already has, and
			// the archive is keyed on this exact normalized url
			byUrl.set(p.url, p);
			node.dataset.url = p.url;
			const code = p.notModified ? 304 : p.status;
			q.status.textContent = code == null ? (p.errorKind ?? "error") : String(code);
			q.status.classList.add(`st-${code == null ? "x" : String(code)[0]}`);
			q.depth.textContent = String(p.depth);
			q.url.textContent = short(p.finalUrl ?? p.url, home);
			q.title.textContent = p.errorMessage ??
				(p.skipReason ? `skipped: ${p.skipReason}` : (p.title ?? ""));
			q.type.textContent = (p.contentType ?? "").split(";")[0];
			q.size.textContent = p.size == null ? "—" : bytes(p.size);
			q.ms.textContent = p.timing?.total == null
				? "—"
				: nf.format(Math.round(p.timing.total));
			return node;
		});
		prepend(r.pagesBody, nodes);
		totals.pages += rows.length;
		r.cPages.textContent = nf.format(totals.pages);
		r.pagesNote.textContent = totals.pages > RENDER_CAP
			? `newest ${RENDER_CAP} of ${nf.format(totals.pages)}`
			: "";
	};

	const renderLinks = (rows: LinkRow[]): void => {
		if (!rows.length) return;
		r.linksEmpty.hidden = true;
		const nodes = rows.map((l) => {
			const node = fromTemplate("tpl-link-row");
			const q = refs(node);
			node.classList.add(l.followed ? "is-followed" : "is-skipped");
			q.to.textContent = l.kind === "external" ? l.toUrl : short(l.toUrl, home);
			q.from.textContent = `from ${short(l.fromUrl, home)}`;
			q.kind.textContent = l.kind === "external"
				? host(l.toUrl) || "external"
				: "internal";
			q.rel.textContent = l.nofollow ? `${l.rel} · nofollow` : l.rel;
			q.followed.textContent = l.followed ? "yes" : "no";
			// the SkipReason is the interesting half: it names the policy that declined
			q.why.textContent = l.followed ? "" : (l.skipReason ?? "—");
			return node;
		});
		prepend(r.linksBody, nodes);
		totals.links += rows.length;
		r.cLinks.textContent = nf.format(totals.links);
		r.linksNote.textContent = totals.links > RENDER_CAP
			? `newest ${RENDER_CAP} of ${nf.format(totals.links)}`
			: "";
	};

	const renderBroken = (
		rows: {
			toUrl: string;
			status: number | null;
			errorKind?: string;
			fromUrls: string[];
		}[],
	): void => {
		r.cBroken.textContent = nf.format(rows.length);
		if (!rows.length) return;
		r.brokenEmpty.hidden = true;
		const frag = document.createDocumentFragment();
		for (const b of rows) {
			const node = fromTemplate("tpl-broken-row");
			const q = refs(node);
			q.url.textContent = b.toUrl;
			q.from.textContent = b.fromUrls.slice(0, 3).map((u) =>
				short(u, home)
			).join(", ") +
				(b.fromUrls.length > 3 ? ` +${b.fromUrls.length - 3} more` : "");
			q.status.textContent = b.status == null
				? (b.errorKind ?? "error")
				: String(b.status);
			q.status.classList.add(`st-${b.status == null ? "x" : String(b.status)[0]}`);
			q.count.textContent = String(b.fromUrls.length);
			frag.appendChild(node);
		}
		r.brokenBody.replaceChildren(frag);
	};

	const renderRecent = (rows: RecentRow[]): void => {
		r.recentEmpty.hidden = rows.length > 0;
		const frag = document.createDocumentFragment();
		for (const c of rows) {
			const node = fromTemplate("tpl-recent-row");
			const q = refs(node);
			const btn = node.querySelector("button") as HTMLButtonElement;
			// a run with a job uid was queued, and queue mode is polled BY that job uid
			btn.dataset.mode = c.jobUid ? "queue" : "direct";
			btn.dataset.uid = c.jobUid ?? c.uid;
			q.seed.textContent = c.seeds[0] ?? "(no seed)";
			q.meta.textContent = [
				c.stoppedBy ?? c.status,
				`${c.stats?.done ?? 0} pages`,
				new Date(c.createdAt).toLocaleTimeString(),
			].join(" · ");
			frag.appendChild(node);
		}
		r.recent.replaceChildren(frag);
	};

	/* -- the page modal -- */

	/** Every page row rendered this session, so the modal can read one back by url. */
	const byUrl = new Map<string, PageRow>();
	let modal: { el: HTMLElement; refs: Record<string, HTMLElement> } | null = null;

	const closeModal = (): void => {
		modal?.el.remove();
		modal = null;
	};

	const selectModalTab = (name: string): void => {
		if (!modal) return;
		const m = modal.refs;
		for (const btn of (m.mtabs as HTMLElement).querySelectorAll("button")) {
			btn.setAttribute("aria-selected", String(btn.dataset.tab === name));
		}
		m.panePreview.hidden = name !== "preview";
		m.paneSource.hidden = name !== "source";
		m.paneExtracted.hidden = name !== "extracted";
	};

	/** Fill the Extracted tab from the row's stored summary and the fresh document. */
	const renderExtracted = (page: PageRow, data: PageDoc): void => {
		const m = modal!.refs;

		const stored = m.stored;
		stored.replaceChildren();
		if (page.data && Object.keys(page.data).length) {
			for (const [k, v] of Object.entries(page.data)) {
				kv(stored, k, Array.isArray(v) ? (v.join(", ") || "—") : v);
			}
		} else {
			kv(stored, "data", "nothing — onPage skipped this page");
		}

		const fresh = m.fresh;
		fresh.replaceChildren();
		const doc = data.doc;
		if (!doc) {
			kv(fresh, "extract", "no archived body to extract from");
			m.markdownSec.hidden = true;
			m.structuredSec.hidden = true;
			return;
		}
		const md = doc.metadata as Record<string, unknown>;
		kv(fresh, "title", doc.title);
		kv(fresh, "lang", doc.lang);
		kv(fresh, "description", md.description);
		kv(fresh, "canonical", md.canonical);
		kv(fresh, "author", md.author);
		kv(fresh, "publishedAt", md.publishedAt);
		kv(fresh, "siteName", md.siteName);
		kv(fresh, "content via", doc.content?.via);
		kv(fresh, "text length", doc.content?.textLength);
		kv(
			fresh,
			"link density",
			doc.content ? doc.content.linkDensity.toFixed(3) : null,
		);
		kv(fresh, "json-ld blocks", doc.jsonLd.length);
		kv(fresh, "embedded json", Object.keys(doc.embeddedJson).join(", "));
		kv(fresh, "microdata items", doc.microdata.length);

		m.markdownSec.hidden = !doc.content;
		if (doc.content) m.markdown.textContent = doc.content.markdown;

		const structured = {
			jsonLd: doc.jsonLd,
			embeddedJson: doc.embeddedJson,
			microdata: doc.microdata,
		};
		const empty = !doc.jsonLd.length && !doc.microdata.length &&
			!Object.keys(doc.embeddedJson).length;
		m.structuredSec.hidden = empty;
		if (!empty) m.structured.textContent = JSON.stringify(structured, null, 2);
	};

	const openPage = async (pageUrl: string): Promise<void> => {
		const page = byUrl.get(pageUrl);
		if (!page) return;

		closeModal();
		const el = fromTemplate("tpl-modal");
		modal = { el, refs: refs(el) };
		const m = modal.refs;
		r.modalHost.appendChild(el);
		selectModalTab("preview");

		m.title.textContent = page.title || short(page.finalUrl ?? page.url, home);
		m.url.textContent = page.finalUrl ?? page.url;
		const badge = (text: string, kind = "") => {
			const b = document.createElement("span");
			b.className = `badge${kind ? ` badge-${kind}` : ""}`;
			b.textContent = text;
			m.badges.appendChild(b);
		};
		badge(
			page.notModified ? "304" : String(page.status ?? page.errorKind ?? "error"),
			page.ok ? "ok" : "bad",
		);
		badge(`depth ${page.depth}`);
		if (page.contentType) badge(page.contentType.split(";")[0]);
		if (page.size != null) badge(bytes(page.size));

		m.source.textContent = "Loading…";

		let data: PageDoc;
		try {
			const res = await fetch(`/api/page?url=${encodeURIComponent(page.url)}`);
			data = await res.json() as PageDoc;
			if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
		} catch (e) {
			if (modal?.refs === m) m.source.textContent = `Could not load it: ${e}`;
			return;
		}
		// the modal may have been closed or replaced while that was in flight
		if (modal?.refs !== m) return;

		if (data.html == null) {
			m.source.textContent =
				"No body archived for this URL — tick “Archive rendered HTML” and crawl again.";
			(m.frame as HTMLIFrameElement).removeAttribute("srcdoc");
			renderExtracted(page, data);
			return;
		}

		m.sourceNote.textContent = [
			`${bytes(data.bytes)} archived`,
			data.contentType ?? "",
			data.charset ?? "",
			data.truncated ? "— shown truncated; extraction saw all of it" : "",
		].filter(Boolean).join(" · ");
		m.source.textContent = data.html;
		(m.frame as HTMLIFrameElement).srcdoc = withBase(
			data.html,
			page.finalUrl ?? page.url,
		);
		renderExtracted(page, data);
	};

	/* -- polling -- */

	const showFailure = (message: string): void => {
		r.errorBox.hidden = false;
		r.errorBox.textContent = message;
	};

	const finish = (): void => {
		startBtn.disabled = false;
		stopBtn.disabled = true;
		void loadRecent();
	};

	const poll = async (mine: number): Promise<void> => {
		if (mine !== session || !current) return;
		const { mode, uid } = current;
		let snap: Snapshot;
		try {
			const res = await fetch(
				`/api/crawl/${mode}/${uid}?pages=${cursors.pages}&links=${cursors.links}`,
			);
			snap = await res.json() as Snapshot;
			if (!res.ok) throw new Error(snap.error ?? `HTTP ${res.status}`);
		} catch (e) {
			if (mine !== session) return;
			showFailure(`Polling stopped: ${e}`);
			finish();
			return;
		}
		if (mine !== session) return;

		cursors.pages += snap.pages.length;
		cursors.links += snap.links.length;
		// from the crawl row, not from the form: a reopened run has to get it from the
		// seeds it actually ran with
		if (home === undefined && snap.crawl?.seeds?.length) {
			home = originOf(snap.crawl.seeds[0]);
		}

		if (snap.job) {
			setBadge(r.jobBadge, `job: ${snap.job.status}`, statusKind(snap.job.status));
		}
		const status = snap.crawl?.status ?? (snap.job ? "queued" : "pending");
		setBadge(r.statusBadge, status, statusKind(status));
		if (snap.crawl?.stoppedBy) {
			setBadge(
				r.stoppedBadge,
				`stoppedBy: ${snap.crawl.stoppedBy}`,
				snap.crawl.stoppedBy === "completed" ? "ok" : "warn",
			);
		}
		const failure = snap.crawl?.error ?? snap.job?.error;
		if (failure) showFailure(failure);

		renderStats(snap);
		renderPages(snap.pages);
		renderLinks(snap.links);
		stopBtn.disabled = !snap.stoppable;

		// a crawl that just ended can still have rows this poll did not reach
		if (!snap.terminal || snap.more) {
			timer = setTimeout(() => void poll(mine), snap.more ? 0 : POLL_MS);
			return;
		}

		if (!brokenLoaded) {
			brokenLoaded = true;
			await fetch(`/api/crawl/${mode}/${uid}/broken`)
				.then((res) => res.json())
				.then((data) => {
					if (mine === session) renderBroken(data.broken ?? []);
				})
				.catch(() => {});
		}
		finish();
	};

	const watch = (mode: Mode, uid: string): void => {
		clearTimeout(timer);
		session++;
		current = { mode, uid };
		reset();
		startBtn.disabled = true;
		stopBtn.disabled = false;
		void poll(session);
	};

	/* -- actions -- */

	/** What this server can actually do — the JS toggle is a lie without Playwright. */
	const loadCapabilities = async (): Promise<void> => {
		const caps = await fetch("/api/capabilities")
			.then((res) => res.json() as Promise<Capabilities>)
			.catch(() => null);
		const box = r.js as HTMLInputElement;
		if (!caps?.browser) {
			box.checked = false;
			box.disabled = true;
			r.jsLabel.textContent = "Render with JS — Playwright not installed";
			r.jsHint.textContent =
				"Browser drivers are never a dependency of this package. `deno add npm:playwright` " +
				"and `deno run -A npm:playwright install chromium` on the server to enable it.";
			return;
		}
		const js = caps.caps.js as { maxPages: number; concurrency: number };
		r.jsHint.textContent =
			`With JS on, every document goes through a real browser and the archived body is ` +
			`the post-JS DOM — so budgets tighten to ${js.maxPages} pages / ${js.concurrency} at a time.`;
	};

	const loadRecent = async (): Promise<void> => {
		await fetch("/api/crawls")
			.then((res) => res.json())
			.then((data) => recent.set(data.crawls ?? []))
			.catch(() => {});
	};

	const start = async (): Promise<void> => {
		const body = readForm();
		if (!body.seeds.length) {
			showFailure("Give me at least one seed URL.");
			return;
		}
		startBtn.disabled = true;
		r.errorBox.hidden = true;
		try {
			const res = await fetch("/api/crawl", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			const data = await res.json() as {
				mode: Mode;
				uid: string;
				notes?: string[];
				error?: string;
			};
			if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
			watch(data.mode, data.uid);
			if (data.notes?.length) {
				r.notes.hidden = false;
				r.notes.innerHTML = "<b>The server clamped your request:</b>";
				const ul = document.createElement("ul");
				for (const n of data.notes) {
					const li = document.createElement("li");
					li.textContent = n;
					ul.appendChild(li);
				}
				r.notes.appendChild(ul);
			}
		} catch (e) {
			showFailure(String(e instanceof Error ? e.message : e));
			startBtn.disabled = false;
		}
	};

	const stop = async (): Promise<void> => {
		if (!current) return;
		stopBtn.disabled = true;
		await fetch(`/api/crawl/${current.mode}/${current.uid}/stop`, { method: "POST" })
			.catch(() => {});
	};

	const selectTab = (name: string): void => {
		for (const btn of (r.tabs as HTMLElement).querySelectorAll("button")) {
			btn.setAttribute("aria-selected", String(btn.dataset.tab === name));
		}
		r.panePages.hidden = name !== "pages";
		r.paneLinks.hidden = name !== "links";
		r.paneBroken.hidden = name !== "broken";
	};

	/* -- wiring -- */

	track(recent.subscribe(renderRecent));

	// One delegated listener tree for the whole view (events bubble to `el`).
	track(delegate(el, {
		submit: (e) => {
			e.preventDefault();
			void start();
		},
		stop: () => void stop(),
		toggleTheme: () => {
			isDark = !isDark;
			applyTheme(isDark);
			localStorage.setItem(THEME_KEY, isDark ? "dark" : "light");
		},
		tab: (_e, target) => selectTab(target.dataset.tab!),
		filterLinks: () => {
			const v = (r.linkFilter as HTMLSelectElement).value;
			r.linksBody.className = v ? `only-${v}` : "";
		},
		openRun: (_e, target) => watch(target.dataset.mode as Mode, target.dataset.uid!),
		openPage: (e, target) => {
			// the row is focusable, so it answers Enter/Space as well as a click
			if (e.type === "keydown") {
				const key = (e as KeyboardEvent).key;
				if (key !== "Enter" && key !== " ") return;
				e.preventDefault();
			}
			void openPage(target.dataset.url!);
		},
		mtab: (_e, target) => selectModalTab(target.dataset.tab!),
		closeModal: () => closeModal(),
		backdrop: (e, target) => {
			// only the backdrop itself, never a click that bubbled out of the dialog
			if (e.target === target) closeModal();
		},
	}));

	const onKeydown = (e: KeyboardEvent) => {
		if (e.key === "Escape" && modal) closeModal();
	};
	document.addEventListener("keydown", onKeydown);
	track(() => document.removeEventListener("keydown", onKeydown));

	// the radios are not `[data-on]` targets (there is nothing to delegate to), so the
	// hint is kept in sync with a plain listener
	const modeChanged = () => syncModeHint();
	for (const node of [r.modeDirect, r.modeQueue]) {
		node.addEventListener("change", modeChanged);
		track(() => node.removeEventListener("change", modeChanged));
	}

	form.setAttribute("novalidate", "");
	setDefaults();
	syncModeHint();
	reset();
	r.version.textContent = `· v${VERSION}`;
	void loadCapabilities();
	void loadRecent();

	return { el };
});

document.getElementById("app")!.appendChild(app.el!);
