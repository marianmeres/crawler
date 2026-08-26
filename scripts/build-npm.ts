import { npmBuild, versionizeDeps } from "@marianmeres/npmbuild";

const denoJson = JSON.parse(Deno.readTextFileSync("deno.json"));

// Only the "./pg" and "./steve" entries reference these; consumers who never import
// those subpaths never need them, and npm does not auto-install optional peers.
// They are ALSO devDependencies because npm considers an absent optional peer
// satisfied — `npm install --no-save pg` is a no-op here — and the build's tsc pass
// still has to resolve `pg`, `@marianmeres/steve` and (through @types/pg) node types.
const optionalPeers = Object.fromEntries(
	versionizeDeps(["pg", "@types/pg", "@marianmeres/steve"], denoJson).map((dep) => {
		const at = dep.lastIndexOf("@");
		return at > 0 ? [dep.slice(0, at), dep.slice(at + 1)] : [dep, "*"];
	}),
);

await npmBuild({
	name: denoJson.name,
	version: denoJson.version,
	repository: denoJson.name.replace(/^@/, ""),
	// keep in sync with deno.json "exports" (npmbuild maps "mod" -> ".", "x" -> "./x");
	// every name here needs its flat `src/{name}.ts` re-export shim
	entryPoints: ["mod", "url", "extract", "stores", "pg", "steve"],
	// page-fetcher is the real runtime dep. clog is not a Deno-side import — `Logger`
	// reaches us re-exported through page-fetcher — but the emitted .d.ts chain ends in
	// clog, so a consumer's tsc must resolve it; hence pinned here, not in deno.json.
	dependencies: versionizeDeps(
		["@marianmeres/page-fetcher", "@marianmeres/clog@^3.21.0"],
		denoJson,
	),
	peerDependencies: optionalPeers,
	peerDependenciesMeta: Object.fromEntries(
		Object.keys(optionalPeers).map((name) => [name, { optional: true }]),
	),
	packageJsonOverrides: { devDependencies: optionalPeers },
	// the sources are written for Deno, which type-checks strict; npmbuild's default
	// `strict: false` turns off the narrowing they rely on (discriminated unions)
	tsconfig: { compilerOptions: { strict: true } },
	// the default rootFiles would ship docs/ (incl. the plan) into the tarball
	rootFiles: ["LICENSE", "README.md", "AGENTS.md"],
});
