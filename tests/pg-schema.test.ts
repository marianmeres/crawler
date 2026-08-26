/**
 * The schema blob against a live server. What matters here is convergence: there is no
 * migration ledger, so the create blob is re-run on every fresh process and has to be a
 * no-op the second time. Both prefix shapes are exercised — a plain `"_test_"` and a
 * `"myschema."`-style one, which is the case the index-name `safe()` strip exists for.
 *
 * Gated on `TEST_PG_DATABASE` only: with the variable set but the server unreachable
 * these tests fail rather than skip.
 *
 * @module
 */

import { assert, assertEquals } from "@std/assert";
import type pg from "pg";
import { createPg } from "./_pg.ts";
import {
	_initialize,
	_tableNames,
	_uninstall,
	type CrawlerTableNames,
} from "../src/pg/_schema.ts";

const hasPg = !!Deno.env.get("TEST_PG_DATABASE");

const TEST_PREFIX = "_test_";

/** The index names the DDL declares, per table. Primary keys are PG's, not ours. */
function expectedIndexes(t: CrawlerTableNames): Record<string, string[]> {
	const safe = (name: string) => name.replace(/\W/g, "");
	return {
		[t.tableUrl]: [`idx_${safe(t.tableUrl)}_tenant_url`],
		[t.tableCrawl]: [
			`idx_${safe(t.tableCrawl)}_job_uid`,
			`idx_${safe(t.tableCrawl)}_tenant_created`,
			`idx_${safe(t.tableCrawl)}_uid`,
		],
		[t.tablePage]: [`idx_${safe(t.tablePage)}_crawl_url`],
		[t.tableLink]: [
			`idx_${safe(t.tableLink)}_crawl_from`,
			`idx_${safe(t.tableLink)}_crawl_to`,
		],
		[t.tableFrontier]: [
			`idx_${safe(t.tableFrontier)}_crawl_url`,
			`idx_${safe(t.tableFrontier)}_pop`,
		],
	};
}

async function tableExists(db: pg.Pool, table: string): Promise<boolean> {
	const { rows } = await db.query(`SELECT to_regclass($1) IS NOT NULL AS present`, [
		table,
	]);
	return rows[0].present;
}

async function indexNames(db: pg.Pool, table: string): Promise<string[]> {
	const { rows } = await db.query(
		`SELECT ci.relname AS name
		   FROM pg_index i
		   JOIN pg_class ci ON ci.oid = i.indexrelid
		  WHERE i.indrelid = to_regclass($1) AND NOT i.indisprimary
		  ORDER BY ci.relname`,
		[table],
	);
	return rows.map((r: { name: string }) => r.name);
}

/** Every table present, with exactly the declared indexes and no duplicates. */
async function assertSchemaIntact(db: pg.Pool, t: CrawlerTableNames): Promise<void> {
	for (const [table, indexes] of Object.entries(expectedIndexes(t))) {
		assert(await tableExists(db, table), `missing table ${table}`);
		assertEquals(await indexNames(db, table), indexes, `indexes of ${table}`);
	}
}

Deno.test({
	name: "pg: schema create converges and round-trips uninstall",
	ignore: !hasPg,
}, async () => {
	const db = createPg();
	const tableNames = _tableNames(TEST_PREFIX);
	try {
		await _initialize({ db, tableNames }, true);
		await assertSchemaIntact(db, tableNames);

		// the no-ledger rule: a second run of the same blob is a no-op, not an error
		await _initialize({ db, tableNames });
		await assertSchemaIntact(db, tableNames);

		await _uninstall({ db, tableNames });
		for (const table of Object.values(tableNames)) {
			assertEquals(await tableExists(db, table), false, `${table} survived drop`);
		}

		await _initialize({ db, tableNames });
		await assertSchemaIntact(db, tableNames);
	} finally {
		await _uninstall({ db, tableNames }).catch(() => {});
		await db.end();
	}
});

Deno.test({
	name: 'pg: schema installs under a "myschema." prefix',
	ignore: !hasPg,
}, async () => {
	const db = createPg();
	// the current schema rather than a fresh one: creating a schema needs a privilege the
	// test role is not guaranteed to have, and the code path under test is the dot
	const { rows } = await db.query(`SELECT current_schema() AS schema`);
	const tableNames = _tableNames(`${rows[0].schema}.${TEST_PREFIX}qualified_`);
	try {
		await _initialize({ db, tableNames }, true);
		await assertSchemaIntact(db, tableNames);

		await _initialize({ db, tableNames });
		await assertSchemaIntact(db, tableNames);

		// index names are never schema-qualified — that is what the `safe()` strip is for
		for (const indexes of Object.values(expectedIndexes(tableNames))) {
			for (const name of indexes) assert(!name.includes("."), name);
		}
	} finally {
		await _uninstall({ db, tableNames }).catch(() => {});
		await db.end();
	}
});
