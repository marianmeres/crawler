/**
 * The `./pg` schema blob: five tables (`__crawler_url|crawl|page|link|frontier`) plus
 * their index set, in cron 3.x's shape — `_schemaCreate` / `_schemaDrop` build SQL,
 * `_initialize` / `_uninstall` run it.
 *
 * Two constraints govern every future edit here:
 *
 * 1. **There is no migration ledger.** The create blob is re-run on every fresh process
 *    and must converge from any starting state, so everything is `IF NOT EXISTS` and
 *    later column growth is a self-healing `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
 *    line appended to the blob.
 * 2. **CHECK constraints only on structurally stable unions.** `CREATE TABLE IF NOT
 *    EXISTS` never updates an existing table's CHECK, so a CHECKed union that later
 *    grows would strand every already-deployed table. `status`, `kind` and
 *    `discovered_via` are CHECKed; `rel` and `skip_reason` deliberately are not.
 *
 * @module
 */

import type pg from "pg";

/** Resolved table names for one `tablePrefix`. @internal */
export interface CrawlerTableNames {
	tableUrl: string;
	tableCrawl: string;
	tablePage: string;
	tableLink: string;
	tableFrontier: string;
}

/** What the schema functions need from the owning `CrawlerPg`. @internal */
export interface CrawlerSchemaContext {
	db: pg.Pool | pg.Client;
	tableNames: CrawlerTableNames;
}

/**
 * The `${prefix}__crawler_*` naming convention. The prefix may carry a schema, e.g.
 * `"myschema."`, in which case every object lands in that schema.
 *
 * @internal
 */
export function _tableNames(tablePrefix: string = ""): CrawlerTableNames {
	return {
		tableUrl: `${tablePrefix}__crawler_url`,
		tableCrawl: `${tablePrefix}__crawler_crawl`,
		tablePage: `${tablePrefix}__crawler_page`,
		tableLink: `${tablePrefix}__crawler_link`,
		tableFrontier: `${tablePrefix}__crawler_frontier`,
	};
}

/** Children first, so the foreign keys never block the drop. @internal */
export function _schemaDrop(
	context: Pick<CrawlerSchemaContext, "tableNames">,
): string {
	const { tableUrl, tableCrawl, tablePage, tableLink, tableFrontier } =
		context.tableNames;
	return `
		DROP TABLE IF EXISTS ${tableFrontier};
		DROP TABLE IF EXISTS ${tableLink};
		DROP TABLE IF EXISTS ${tablePage};
		DROP TABLE IF EXISTS ${tableCrawl};
		DROP TABLE IF EXISTS ${tableUrl};
	`;
}

/** @internal */
export function _schemaCreate(
	context: Pick<CrawlerSchemaContext, "tableNames">,
): string {
	const { tableUrl, tableCrawl, tablePage, tableLink, tableFrontier } =
		context.tableNames;

	// index names are never schema-qualified, so strip the "myschema." prefix out of the
	// name we derive from the table (cron/_schema.ts:18)
	const safe = (name: string) => `${name}`.replace(/\W/g, "");

	return `
		CREATE TABLE IF NOT EXISTS ${tableUrl} (
			id            SERIAL PRIMARY KEY,
			tenant_id     TEXT NOT NULL DEFAULT '_default',
			url           TEXT NOT NULL,
			body          BYTEA,
			content_type  TEXT,
			charset       TEXT,
			etag          TEXT,
			last_modified TEXT,
			content_hash  TEXT,
			last_status   INTEGER,
			size          INTEGER,
			fetched_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
		);

		CREATE UNIQUE INDEX IF NOT EXISTS idx_${safe(tableUrl)}_tenant_url
			ON ${tableUrl}(tenant_id, url);

		CREATE TABLE IF NOT EXISTS ${tableCrawl} (
			id         SERIAL PRIMARY KEY,
			uid        UUID NOT NULL DEFAULT gen_random_uuid(),
			tenant_id  TEXT NOT NULL DEFAULT '_default',
			seeds      JSONB NOT NULL DEFAULT '[]',
			options    JSONB NOT NULL DEFAULT '{}',
			status     VARCHAR(20) NOT NULL DEFAULT 'pending'
				CHECK (status IN ('pending','running','completed','failed','stopped')),
			stats      JSONB NOT NULL DEFAULT '{}',
			stopped_by VARCHAR(20),
			error      TEXT,
			job_uid    UUID,
			started_at TIMESTAMPTZ,
			ended_at   TIMESTAMPTZ,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		);

		CREATE UNIQUE INDEX IF NOT EXISTS idx_${safe(tableCrawl)}_uid
			ON ${tableCrawl}(uid);

		CREATE INDEX IF NOT EXISTS idx_${safe(tableCrawl)}_tenant_created
			ON ${tableCrawl}(tenant_id, created_at DESC);

		CREATE INDEX IF NOT EXISTS idx_${safe(tableCrawl)}_job_uid
			ON ${tableCrawl}(job_uid) WHERE job_uid IS NOT NULL;

		CREATE TABLE IF NOT EXISTS ${tablePage} (
			id             SERIAL PRIMARY KEY,
			tenant_id      TEXT NOT NULL DEFAULT '_default',
			crawl_id       INTEGER NOT NULL,
			url_id         INTEGER,
			url            TEXT NOT NULL,
			final_url      TEXT,
			depth          INTEGER NOT NULL DEFAULT 0,
			discovered_via VARCHAR(20) NOT NULL DEFAULT 'link'
				CHECK (discovered_via IN
					('seed','link','sitemap','redirect','canonical','manual')),
			referrer       TEXT,
			status         INTEGER,
			ok             BOOLEAN NOT NULL DEFAULT FALSE,
			not_modified   BOOLEAN NOT NULL DEFAULT FALSE,
			content_type   TEXT,
			content_hash   TEXT,
			title          TEXT,
			size           INTEGER,
			attempts       INTEGER NOT NULL DEFAULT 0,
			timing         JSONB NOT NULL DEFAULT '{}',
			error_kind     VARCHAR(40),
			error_message  TEXT,
			skip_reason    VARCHAR(30),
			data           JSONB,
			fetched_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

			FOREIGN KEY (crawl_id) REFERENCES ${tableCrawl}(id)
				ON UPDATE CASCADE ON DELETE CASCADE,
			FOREIGN KEY (url_id) REFERENCES ${tableUrl}(id)
				ON UPDATE CASCADE ON DELETE SET NULL
		);

		CREATE UNIQUE INDEX IF NOT EXISTS idx_${safe(tablePage)}_crawl_url
			ON ${tablePage}(crawl_id, url);

		CREATE TABLE IF NOT EXISTS ${tableLink} (
			id          SERIAL PRIMARY KEY,
			tenant_id   TEXT NOT NULL DEFAULT '_default',
			crawl_id    INTEGER NOT NULL,
			from_url    TEXT NOT NULL,
			to_url      TEXT NOT NULL,
			raw_href    TEXT,
			kind        VARCHAR(10) NOT NULL DEFAULT 'internal'
				CHECK (kind IN ('internal','external')),
			rel         VARCHAR(20) NOT NULL DEFAULT 'page',
			nofollow    BOOLEAN NOT NULL DEFAULT FALSE,
			anchor_text TEXT,
			followed    BOOLEAN NOT NULL DEFAULT FALSE,
			skip_reason VARCHAR(30),
			created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

			FOREIGN KEY (crawl_id) REFERENCES ${tableCrawl}(id)
				ON UPDATE CASCADE ON DELETE CASCADE
		);

		CREATE INDEX IF NOT EXISTS idx_${safe(tableLink)}_crawl_to
			ON ${tableLink}(crawl_id, to_url);

		CREATE INDEX IF NOT EXISTS idx_${safe(tableLink)}_crawl_from
			ON ${tableLink}(crawl_id, from_url);

		CREATE TABLE IF NOT EXISTS ${tableFrontier} (
			id             SERIAL PRIMARY KEY,
			tenant_id      TEXT NOT NULL DEFAULT '_default',
			crawl_id       INTEGER NOT NULL,
			url            TEXT NOT NULL,
			host           TEXT NOT NULL,
			depth          INTEGER NOT NULL DEFAULT 0,
			priority       DOUBLE PRECISION NOT NULL DEFAULT 0,
			discovered_via VARCHAR(20) NOT NULL DEFAULT 'link'
				CHECK (discovered_via IN
					('seed','link','sitemap','redirect','canonical','manual')),
			referrer       TEXT,
			meta           JSONB,
			status         VARCHAR(10) NOT NULL DEFAULT 'pending'
				CHECK (status IN ('pending','in_flight','done')),
			ready_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			claimed_at     TIMESTAMPTZ,
			created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

			FOREIGN KEY (crawl_id) REFERENCES ${tableCrawl}(id)
				ON UPDATE CASCADE ON DELETE CASCADE
		);

		CREATE UNIQUE INDEX IF NOT EXISTS idx_${safe(tableFrontier)}_crawl_url
			ON ${tableFrontier}(crawl_id, url);

		CREATE INDEX IF NOT EXISTS idx_${safe(tableFrontier)}_pop
			ON ${tableFrontier}(crawl_id, status, priority);
	`;
}

/** @internal */
export async function _initialize(
	context: CrawlerSchemaContext,
	hard = false,
): Promise<void> {
	const sql = [hard && _schemaDrop(context), _schemaCreate(context)]
		.filter(Boolean)
		.join("\n");

	// a multi-statement simple query is one implicit transaction server-side, so the
	// blob stays all-or-nothing without pinning a client out of the pool
	await context.db.query(sql);
}

/** @internal */
export async function _uninstall(context: CrawlerSchemaContext): Promise<void> {
	await context.db.query(_schemaDrop(context));
}
