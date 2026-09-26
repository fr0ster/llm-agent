import { quoteIdent } from './schema.js';

/** The table a HanaVectorRagProvider keeps one record per collection in, by default. */
export const DEFAULT_CATALOG_TABLE = 'rag_collection_catalog';

/**
 * The catalog's DDL. No IF NOT EXISTS — a server-version capability on HANA
 * (spec §9.10): the provider checks for the table, creates it, and re-checks on
 * failure. Exported for an operator running with `autoCreateSchema: false`.
 */
export function createCatalogTableSql(table: string): string {
  return `CREATE TABLE ${quoteIdent(table)} (
    store_name NVARCHAR(63) PRIMARY KEY,
    collection_name NVARCHAR(5000) NOT NULL,
    scope NVARCHAR(16) NOT NULL,
    user_id NVARCHAR(5000),
    session_id NVARCHAR(5000),
    attributes_json NCLOB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`;
}

/** In the configured schema when there is one, else the connection's current one. */
export function tableExistsSql(explicitSchema: boolean): string {
  return explicitSchema
    ? 'SELECT COUNT(*) AS "n" FROM SYS.TABLES WHERE SCHEMA_NAME = ? AND TABLE_NAME = ?'
    : 'SELECT COUNT(*) AS "n" FROM SYS.TABLES WHERE SCHEMA_NAME = CURRENT_SCHEMA AND TABLE_NAME = ?';
}

/** Fails with the backend's own error when the table is not there. */
export function probeTableSql(table: string): string {
  return `SELECT COUNT(*) AS "n" FROM ${quoteIdent(table)} WHERE 1 = 0`;
}

export function recordExistsSql(table: string): string {
  return `SELECT 1 AS "present" FROM ${quoteIdent(table)} WHERE store_name = ?`;
}

/** Create-if-absent: the primary key refuses a second record for one store. */
export function insertRecordSql(table: string): string {
  return `INSERT INTO ${quoteIdent(table)} (store_name, collection_name, scope, user_id, session_id, attributes_json) VALUES (?, ?, ?, ?, ?, ?)`;
}

export function selectRecordsSql(table: string): string {
  return `SELECT store_name AS "storeName", collection_name AS "name", scope AS "scope", user_id AS "userId", session_id AS "sessionId", attributes_json AS "attributesJson" FROM ${quoteIdent(table)} ORDER BY store_name`;
}

export function deleteRecordSql(table: string): string {
  return `DELETE FROM ${quoteIdent(table)} WHERE store_name = ?`;
}
