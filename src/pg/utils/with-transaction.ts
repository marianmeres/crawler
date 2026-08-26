/**
 * `withTransaction` — one BEGIN/COMMIT/ROLLBACK per callback, acquiring a client from the
 * pool when there is one. Vendored from the sibling `@marianmeres` PG packages, which
 * each carry their own copy of this helper rather than sharing a dependency.
 *
 * @module
 */

import type pg from "pg";

// deno-lint-ignore no-explicit-any -- pg's .query overloads are complex and vary by driver
export type Queryable = { query: (...args: any[]) => Promise<any> };

/** `pg.Pool` exposes `totalCount`/`idleCount`/`waitingCount`; `pg.Client` does not. */
export function isPool(db: pg.Pool | pg.Client): db is pg.Pool {
	return (
		typeof (db as unknown as { connect?: unknown }).connect === "function" &&
		"totalCount" in db
	);
}

/**
 * A `pg.Client` is a single socket, so concurrent transactions on one would interleave
 * their BEGIN/COMMIT and silently commit each other's work. Chaining them per connection
 * makes a Client correct — but serial, which is why a Pool is what to inject for
 * `concurrency > 1`.
 */
const clientChains = new WeakMap<pg.Client, Promise<unknown>>();

export async function withTransaction<T>(
	db: pg.Pool | pg.Client,
	fn: (client: pg.PoolClient | pg.Client) => Promise<T>,
): Promise<T> {
	if (isPool(db)) return await runTransaction(db, fn);

	const previous = clientChains.get(db) ?? Promise.resolve();
	const current = previous.then(() => runTransaction(db, fn));
	clientChains.set(db, current.catch(() => {}));
	return await current;
}

async function runTransaction<T>(
	db: pg.Pool | pg.Client,
	fn: (client: pg.PoolClient | pg.Client) => Promise<T>,
): Promise<T> {
	const pool = isPool(db);
	const client = pool ? await (db as pg.Pool).connect() : (db as pg.Client);
	try {
		await client.query("BEGIN");
		try {
			const result = await fn(client);
			await client.query("COMMIT");
			return result;
		} catch (e) {
			try {
				await client.query("ROLLBACK");
			} catch {
				// ROLLBACK itself may fail on an already-aborted connection; best-effort.
			}
			throw e;
		}
	} finally {
		if (pool) (client as pg.PoolClient).release();
	}
}
