/**
 * Internal — the string-only private/internal host check behind
 * {@linkcode "../types.ts".CrawlOptions.allowPrivateHosts}.
 *
 * A crawler follows links written by other people, and "other people" includes anyone
 * who can get a URL onto a page you crawl. Pointing one at `http://169.254.169.254/`
 * turns your crawler into a cloud-metadata reader, and at `http://10.0.0.5/` into a
 * scanner of your own network. That is server-side request forgery with extra steps,
 * and it is why this check exists.
 *
 * ## Caveat, stated plainly
 *
 * This is a **string-only** check of the hostname. It cannot detect a public hostname
 * that resolves — or is rebound — to a private address, so it is a speed bump, not a
 * boundary. For real protection resolve the hostname yourself (`Deno.resolveDns`) and
 * re-check every returned address, or put the crawler behind an egress proxy.
 *
 * Ported from `@marianmeres/collection`'s `isPrivateHost`, caveat included.
 *
 * @module
 */

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const V4_MAPPED_RE = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/;

/**
 * Is `hostname` a loopback, private, link-local or otherwise non-public address?
 *
 * Covers `localhost` (and `*.localhost`), the unspecified addresses, the RFC 1918
 * ranges, CGNAT (`100.64.0.0/10`), link-local (`169.254.0.0/16` — the cloud metadata
 * endpoint), IPv6 loopback/unspecified, `fe80::/10`, `fc00::/7`, and the IPv4-mapped
 * IPv6 spelling of any of the above.
 *
 * Bracketed IPv6 literals (what `URL.hostname` gives you) are accepted as-is. Never
 * throws.
 *
 * @example
 * ```ts
 * isPrivateHost("169.254.169.254"); // => true  (cloud metadata)
 * isPrivateHost("[::1]");           // => true
 * isPrivateHost("example.com");     // => false
 * ```
 */
export function isPrivateHost(hostname: string): boolean {
	if (typeof hostname !== "string" || hostname === "") return false;

	let host = hostname.trim().toLowerCase();
	if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
	// a trailing root label is not part of the name
	while (host.endsWith(".")) host = host.slice(0, -1);
	if (host === "") return false;

	if (
		host === "localhost" || host === "127.0.0.1" || host === "::1" ||
		host === "::" || host === "0.0.0.0" || host.endsWith(".localhost")
	) {
		return true;
	}

	const mapped = V4_MAPPED_RE.exec(host);
	const ipv4 = IPV4_RE.exec(mapped ? mapped[1] : host);
	if (ipv4) {
		const a = Number(ipv4[1]);
		const b = Number(ipv4[2]);
		if (a > 255 || b > 255 || Number(ipv4[3]) > 255 || Number(ipv4[4]) > 255) {
			return false; // not an IPv4 address at all
		}
		if (a === 0) return true; // 0.0.0.0/8 — "this network"
		if (a === 10) return true; // 10.0.0.0/8
		if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
		if (a === 127) return true; // 127.0.0.0/8 loopback
		if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
		if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
		if (a === 192 && b === 168) return true; // 192.168.0.0/16
		return false;
	}

	if (host.includes(":")) {
		if (host.startsWith("fe80:")) return true; // link-local
		if (host.startsWith("fc") || host.startsWith("fd")) return true; // unique local
	}

	return false;
}
