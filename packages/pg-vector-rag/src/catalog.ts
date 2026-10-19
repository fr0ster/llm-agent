import { qualifiedTable, quoteIdent } from './schema.js';

/** The table a PgVectorRagProvider keeps one record per collection in, by default. */
export const DEFAULT_CATALOG_TABLE = 'rag_collection_catalog';

/** The catalog's column list, shared with the shipped shared-layout DDL. */
export function catalogColumnsSql(): string {
  return `    store_name VARCHAR(63) PRIMARY KEY,
    collection_name TEXT NOT NULL,
    scope VARCHAR(16) NOT NULL,
    user_id TEXT,
    session_id TEXT,
    attributes_json TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()`;
}

/**
 * The catalog's DDL. No IF NOT EXISTS: the provider checks for the table,
 * creates it, and re-checks on failure (spec §9.10). Exported so an operator
 * running with `autoCreateSchema: false` can create it. Attributes are JSON
 * text, so null and absent stay apart and nothing is normalized.
 */
export function createCatalogTableSql(table: string): string {
  return `CREATE TABLE ${quoteIdent(table)} (
${catalogColumnsSql()}
  )`;
}

/** Resolves like the handles' own statements do: through the search_path. */
export function tableExistsSql(): string {
  return 'SELECT to_regclass($1) IS NOT NULL AS present';
}

/** Fails with the backend's own error when the table is not there. */
export function probeTableSql(table: string): string {
  return `SELECT COUNT(*) AS n FROM ${quoteIdent(table)} WHERE 1 = 0`;
}

export function recordExistsSql(table: string, schema?: string): string {
  return `SELECT 1 AS present FROM ${qualifiedTable(table, schema)} WHERE store_name = $1`;
}

/** Create-if-absent: the primary key refuses a second record for one store. */
export function insertRecordSql(table: string, schema?: string): string {
  return `INSERT INTO ${qualifiedTable(table, schema)} (store_name, collection_name, scope, user_id, session_id, attributes_json) VALUES ($1, $2, $3, $4, $5, $6)`;
}

export function selectRecordsSql(table: string, schema?: string): string {
  return `SELECT store_name AS "storeName", collection_name AS "name", scope AS "scope", user_id AS "userId", session_id AS "sessionId", attributes_json AS "attributesJson" FROM ${qualifiedTable(table, schema)} ORDER BY store_name`;
}

export function deleteRecordSql(table: string, schema?: string): string {
  return `DELETE FROM ${qualifiedTable(table, schema)} WHERE store_name = $1`;
}

/**
 * Updates the display name and/or the attributes of one record. A NULL
 * parameter keeps the column as it is; `store_name`, `scope` and the owner
 * are never in the SET list. Zero rows updated means there is no record.
 */
export function updateRecordSql(table: string, schema?: string): string {
  return `UPDATE ${qualifiedTable(table, schema)} SET collection_name = COALESCE($1, collection_name), attributes_json = COALESCE($2, attributes_json) WHERE store_name = $3`;
}
