import { quoteIdent } from './schema.js';

/** The table a PgVectorRagProvider keeps one record per collection in, by default. */
export const DEFAULT_CATALOG_TABLE = 'rag_collection_catalog';

/**
 * The catalog's DDL. No IF NOT EXISTS: the provider checks for the table,
 * creates it, and re-checks on failure (spec §9.10). Exported so an operator
 * running with `autoCreateSchema: false` can create it. Attributes are JSON
 * text, so null and absent stay apart and nothing is normalized.
 */
export function createCatalogTableSql(table: string): string {
  return `CREATE TABLE ${quoteIdent(table)} (
    store_name VARCHAR(63) PRIMARY KEY,
    collection_name TEXT NOT NULL,
    scope VARCHAR(16) NOT NULL,
    user_id TEXT,
    session_id TEXT,
    attributes_json TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
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

export function recordExistsSql(table: string): string {
  return `SELECT 1 AS present FROM ${quoteIdent(table)} WHERE store_name = $1`;
}

/** Create-if-absent: the primary key refuses a second record for one store. */
export function insertRecordSql(table: string): string {
  return `INSERT INTO ${quoteIdent(table)} (store_name, collection_name, scope, user_id, session_id, attributes_json) VALUES ($1, $2, $3, $4, $5, $6)`;
}

export function selectRecordsSql(table: string): string {
  return `SELECT store_name AS "storeName", collection_name AS "name", scope AS "scope", user_id AS "userId", session_id AS "sessionId", attributes_json AS "attributesJson" FROM ${quoteIdent(table)} ORDER BY store_name`;
}

export function deleteRecordSql(table: string): string {
  return `DELETE FROM ${quoteIdent(table)} WHERE store_name = $1`;
}
