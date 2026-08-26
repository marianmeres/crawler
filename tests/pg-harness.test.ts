/**
 * The PG harness itself: with `TEST_PG_*` set this must reach a real server, and with it
 * unset the test must skip without noise. Every `pg-*.test.ts` suite is gated the same
 * way, so a broken `TEST_PG_*` shows up here rather than as eight confusing failures.
 *
 * @module
 */

import { assertEquals } from "@std/assert";
import { createPg } from "./_pg.ts";

const hasPg = !!Deno.env.get("TEST_PG_DATABASE");

Deno.test(
	{ name: "pg: harness connects and closes cleanly", ignore: !hasPg },
	async () => {
		const pool = createPg();
		try {
			const { rows } = await pool.query("SELECT 1 AS one");
			assertEquals(rows[0].one, 1);
		} finally {
			await pool.end();
		}
	},
);
