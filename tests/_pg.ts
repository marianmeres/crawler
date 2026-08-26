/**
 * PG test harness: a `pg.Pool` over the `TEST_PG_*` environment (loaded by
 * `deno task test`'s `--env-file`), copied from the steve/cron pattern.
 *
 * Suites that need a database gate themselves on `TEST_PG_DATABASE` and **skip
 * silently** when it is unset, so this package's pure suites still pass on a machine
 * without PG:
 *
 * ```ts
 * const hasPg = !!Deno.env.get("TEST_PG_DATABASE");
 * Deno.test({ name: "pg: …", ignore: !hasPg }, async () => { … });
 * ```
 *
 * Every suite closes its pool in a `finally` — Deno's leak detection fails a test that
 * leaves pool sockets open.
 *
 * @module
 */

import pg from "pg";

const { PG_HOST, PG_DATABASE, PG_USER, PG_PASSWORD, PG_PORT } = {
	PG_HOST: Deno.env.get("TEST_PG_HOST") || "localhost",
	PG_DATABASE: Deno.env.get("TEST_PG_DATABASE"),
	PG_USER: Deno.env.get("TEST_PG_USER"),
	PG_PASSWORD: Deno.env.get("TEST_PG_PASSWORD"),
	PG_PORT: Deno.env.get("TEST_PG_PORT") || "5432",
};

function connection() {
	return {
		host: PG_HOST,
		user: PG_USER,
		database: PG_DATABASE,
		password: PG_PASSWORD,
		port: parseInt(PG_PORT),
	};
}

export function createPg() {
	return new pg.Pool(connection());
}

/**
 * The single-connection half of the `db: pg.Pool | pg.Client` contract. Returned
 * unconnected — `await client.connect()` before use, `client.end()` in `finally`.
 */
export function createPgClient() {
	return new pg.Client(connection());
}
