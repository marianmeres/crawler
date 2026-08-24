import { assert, assertEquals } from "@std/assert";
import { type NormalizeOptions, normalizeUrl } from "../../src/url/normalize-url.ts";
import { getRegistrableDomain, isSameSite } from "../../src/url/same-site.ts";

/**
 * Property tests for `./url`.
 *
 * The design requires `normalizeUrl(normalizeUrl(x)) === normalizeUrl(x)` to hold for
 * everything, under every option profile — a property a table of examples can only
 * sample. So we generate adversarial URLs from a seeded PRNG instead: no `Math.random`
 * anywhere, which means a failure here is reproducible from the printed input alone.
 */

const SEED = 0x2f6e2b1;
const ITERATIONS = 1500;

/** xorshift32 — tiny, deterministic, good enough to shuffle test corpora. */
function makeRandom(seed: number): () => number {
	let state = seed | 0 || 1;
	return () => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return (state >>> 0) / 0x100000000;
	};
}

const SCHEMES = [
	"http://",
	"https://",
	"HTTPS://",
	"ftp://",
	"file://",
	"mailto:",
	"javascript:",
	"data:text/plain,",
	"git:",
	"//",
];

const HOSTS = [
	"a.com",
	"WWW.a.com",
	"www.www.a.co.uk",
	"münchen.de",
	"xn--mnchen-3ya.de",
	"127.0.0.1",
	"0x7f.1",
	"[::1]",
	"localhost",
	"a.com.",
	"sub.deep.a.com",
	"a.com:8080",
	"a.com:80",
	"a.com:443",
	"user:pass@a.com",
	":pass@a.com",
	"user@a.com",
	"u%3As:p@a.com",
];

const PATHS = [
	"",
	"/",
	"//",
	"///",
	"/a",
	"/a/",
	"/a//b",
	"/a/b///",
	"/a/../b",
	"/a/./b/",
	"/a/%2e%2e/b",
	"/a/%2e%2e%2e/b",
	"/%7e",
	"/%7E%2D%5F%2E",
	"/%2f",
	"/%2F%2f",
	"/%c3%a9",
	"/100%",
	"/a%2",
	"/a%G0",
	"/%",
	"/%%%",
	"/é/日本",
	"/a b",
	"/{}|^`",
	'/a"b<c>d',
	"/a\\b",
	"/~-._",
	"/A/B/C",
	"/..%2f..",
	"/x/%2E",
	"/%43:",
	"/C:/x",
	"//C:/x",
	"/e|",
	"/.//x",
	"/..//",
];

const QUERIES = [
	"",
	"?",
	"?a=1",
	"?b=2&a=1",
	"?B=2&a=1&b=3",
	"?utm_source=x&utm_medium=y&a=1",
	"?fbclid=x",
	"?PHPSESSID=x&a=1",
	"?a=&b=",
	"?flag",
	"?flag&a=1",
	"?q=a b",
	"?q=a+b",
	"?q=a%20b",
	"?q=~",
	"?q=%7E",
	"?q=a%26b&r=a=b",
	"?q=é",
	"?q=%F0%9F%99%82",
	"?a=1&a=2&a=1",
	"?%zz=1",
	"?=novalue",
];

const FRAGMENTS = [
	"",
	"#",
	"#top",
	"#!/route",
	"#!",
	"#a b",
	"#%7e",
	"#%2e%2e",
	"#/a/../b",
];

const PROFILES: { name: string; opts: NormalizeOptions }[] = [
	{ name: "defaults", opts: {} },
	{
		name: "all-off",
		opts: {
			stripFragment: false,
			normalizeEncoding: false,
			collapseSlashes: false,
			trailingSlash: "keep",
			normalizeQuery: false,
			sortParams: false,
			stripEmptyParams: false,
			stripWww: false,
		},
	},
	{
		name: "all-on",
		opts: {
			stripFragment: false,
			keepHashbang: true,
			normalizeEncoding: true,
			collapseSlashes: true,
			trailingSlash: "strip",
			normalizeQuery: true,
			sortParams: true,
			stripEmptyParams: true,
			stripWww: true,
		},
	},
	{
		name: "raw-query-canonical-encoding",
		opts: { normalizeQuery: false, normalizeEncoding: true, stripFragment: false },
	},
	{
		// Everything outside http(s) goes through the step-12 reassembly guard; this
		// profile is what keeps that path honest. Opaque paths (mailto:, data:),
		// non-numeric ports (git:) and file: drive letters all live here.
		name: "widened-non-http-schemes",
		opts: {
			stripFragment: true,
			normalizeEncoding: true,
			collapseSlashes: true,
			trailingSlash: "strip",
			normalizeQuery: true,
			allowSchemes: [
				"http:",
				"https:",
				"ftp:",
				"file:",
				"mailto:",
				"data:",
				"git:",
			],
		},
	},
	{
		name: "keep-shape-widened-schemes",
		opts: {
			collapseSlashes: false,
			trailingSlash: "strip",
			stripWww: true,
			keepHashbang: true,
			stripFragment: true,
			allowSchemes: ["http:", "https:", "ftp:"],
		},
	},
];

function generateUrl(random: () => number): string {
	const pick = <T>(xs: T[]): T => xs[Math.floor(random() * xs.length)];
	return pick(SCHEMES) + pick(HOSTS) + pick(PATHS) + pick(QUERIES) + pick(FRAGMENTS);
}

Deno.test("property: normalizeUrl is idempotent and produces parsable output", async (t) => {
	for (const profile of PROFILES) {
		await t.step(profile.name, () => {
			const random = makeRandom(SEED);
			let produced = 0;
			for (let i = 0; i < ITERATIONS; i++) {
				const input = generateUrl(random);
				const base = random() < 0.3 ? "https://base.example/p/q/r" : undefined;

				const once = normalizeUrl(input, base, profile.opts);
				if (once === null) continue;
				produced++;

				// the output must be a real, absolute URL
				try {
					new URL(once);
				} catch {
					throw new Error(
						`unparsable output for ${
							JSON.stringify(input)
						} (base=${base}): ` +
							JSON.stringify(once),
					);
				}
				// http(s) paths/queries always come back percent-encoded, so no
				// whitespace can survive. (An opaque path under a widened scheme
				// legitimately can — `new URL("git::a@b/x y").href` keeps it too.)
				if (once.startsWith("http:") || once.startsWith("https:")) {
					assert(
						!/\s/.test(once),
						`output contains whitespace: ${JSON.stringify(once)}`,
					);
				}

				// ...and normalizing it again must change nothing
				const twice = normalizeUrl(once, undefined, profile.opts);
				assertEquals(
					twice,
					once,
					`not idempotent for ${JSON.stringify(input)} (base=${base}): ` +
						`${JSON.stringify(once)} -> ${JSON.stringify(twice)}`,
				);
			}
			// a profile that rejected everything would pass vacuously
			assert(
				produced > ITERATIONS / 10,
				`${profile.name} only produced ${produced} non-null results`,
			);
		});
	}
});

Deno.test("property: normalizeUrl never throws on arbitrary input", () => {
	const random = makeRandom(SEED ^ 0x5bf03635);
	const alphabet = [
		..."abcXYZ019:/?#[]@!$&'()*+,;=%-._~",
		"\\",
		'"',
		"<",
		">",
		"{",
		"}",
		"|",
		"^",
		"`",
		" ",
		"\t",
		"\n",
		"é",
		"日",
		"🙂",
	];
	for (let i = 0; i < 3000; i++) {
		const length = Math.floor(random() * 40);
		let s = "";
		for (let j = 0; j < length; j++) {
			s += alphabet[Math.floor(random() * alphabet.length)];
		}
		const base = random() < 0.5 ? "https://base.example/p" : s;
		const profile = PROFILES[Math.floor(random() * PROFILES.length)];
		// must not throw for any input/base/profile combination
		const out = normalizeUrl(s, base, profile.opts);
		if (out !== null) {
			assertEquals(
				normalizeUrl(out, undefined, profile.opts),
				out,
				`not idempotent for random input ${JSON.stringify(s)} ` +
					`(base=${JSON.stringify(base)})`,
			);
		}
	}
});

Deno.test("property: getRegistrableDomain is a fixed point and never throws", () => {
	const random = makeRandom(SEED ^ 0x1a2b3c4d);
	const labels = [
		"a",
		"www",
		"co",
		"com",
		"uk",
		"sk",
		"example",
		"xn--mnchen-3ya",
		"",
		"-",
		"x".repeat(64),
	];
	for (let i = 0; i < 3000; i++) {
		const count = 1 + Math.floor(random() * 5);
		const host: string[] = [];
		for (let j = 0; j < count; j++) {
			host.push(labels[Math.floor(random() * labels.length)]);
		}
		const raw = host.join(".");

		const once = getRegistrableDomain(raw);
		if (once === null) continue;
		assertEquals(
			getRegistrableDomain(once),
			once,
			`not a fixed point: ${JSON.stringify(raw)} -> ${JSON.stringify(once)}`,
		);
		// a registrable domain is always a suffix of the host it came from
		const normalized = raw.trim().toLowerCase().replace(/\.$/, "");
		assert(
			normalized === once || normalized.endsWith("." + once),
			`${JSON.stringify(once)} is not a suffix of ${JSON.stringify(normalized)}`,
		);
	}
});

Deno.test("property: isSameSite is reflexive, symmetric and mode-monotone", () => {
	const random = makeRandom(SEED ^ 0x77aa33cc);
	const urls = [
		"https://a.com/",
		"https://www.a.com/",
		"https://blog.a.com/",
		"https://a.co.uk/",
		"https://x.a.co.uk/",
		"https://b.com/",
		"https://127.0.0.1/",
		"https://[::1]/",
		"https://localhost:8080/",
		"https://co.uk/",
	];
	for (let i = 0; i < 2000; i++) {
		const a = urls[Math.floor(random() * urls.length)];
		const b = urls[Math.floor(random() * urls.length)];

		for (const subdomains of ["same-host", "same-site", "any"] as const) {
			const opts = { subdomains };
			assertEquals(
				isSameSite(a, b, opts),
				isSameSite(b, a, opts),
				`asymmetric for ${a} / ${b} (${subdomains})`,
			);
		}

		// same-host implies same-site implies any
		if (isSameSite(a, b, { subdomains: "same-host" })) {
			assert(
				isSameSite(a, b, { subdomains: "same-site" }),
				`${a} / ${b} same-host but not same-site`,
			);
		}
		if (isSameSite(a, b, { subdomains: "same-site" })) {
			assert(
				isSameSite(a, b, { subdomains: "any" }),
				`${a} / ${b} same-site but not any`,
			);
		}

		assert(isSameSite(a, a), `not reflexive: ${a}`);
	}
});
