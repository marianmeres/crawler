/**
 * Fixture loading for the test suite.
 *
 * The corpora under `tests/fixtures/` are the executable half of the `./url` and
 * `./extract` specs: each file encodes one pathology, and the suite that reads it says
 * — in one assertion — what the parser is expected to make of it. Keeping the loader
 * here means a fixture is named once and reused, rather than re-read with a slightly
 * different path from every suite.
 *
 * Reads are synchronous and relative to this file, so they work regardless of the
 * directory `deno test` was started from. They need `--allow-read`; the `test` task
 * runs with `-A`, and a narrow `deno test --allow-read=tests` is enough for the pure
 * suites.
 *
 * @module
 */

import { join } from "@std/path";

const FIXTURES = join(import.meta.dirname!, "fixtures");

/** Absolute path of a fixture, e.g. `fixturePath("html", "basic.html")`. */
export function fixturePath(...segments: string[]): string {
	return join(FIXTURES, ...segments);
}

/** Contents of a fixture, e.g. `readFixture("robots", "basic.txt")`. */
export function readFixture(...segments: string[]): string {
	return Deno.readTextFileSync(fixturePath(...segments));
}

/**
 * File names in a fixture directory, sorted — for the "every fixture is used" manifest.
 *
 * Dotfiles are skipped: `.DS_Store` is not a fixture, and a macOS checkout growing one
 * must not fail an unrelated test. Symlinks are followed (`isFile` is false for them),
 * so a fixture linked in from elsewhere still counts.
 */
export function listFixtures(...segments: string[]): string[] {
	const dir = fixturePath(...segments);
	return [...Deno.readDirSync(dir)]
		.filter((entry) => !entry.name.startsWith("."))
		.filter((entry) =>
			entry.isFile ||
			(entry.isSymlink && Deno.statSync(join(dir, entry.name)).isFile)
		)
		.map((entry) => entry.name)
		.sort();
}
