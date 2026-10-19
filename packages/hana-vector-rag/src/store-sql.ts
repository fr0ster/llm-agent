import { createTableSql, quoteIdent } from './schema.js';

export type SqlStatement = { sql: string; params: unknown[] };

/** The SQL a `HanaVectorRag` sends, per table layout. */
export interface HanaStoreSql {
  readonly layout: 'per-collection' | 'shared';
  /** `undefined` in `shared`: no DDL ever reaches the client. */
  createTable(): string | undefined;
  search(vectorLiteral: string, limit?: number): SqlStatement;
  byId(id: string): SqlStatement;
  upsert(
    vectorLiteral: string,
    id: string,
    text: string,
    metadataJson: string,
  ): SqlStatement;
  deleteById(id: string): SqlStatement;
  clear(): SqlStatement;
  countRows(): SqlStatement;
  /** One page of rows ordered by `"ID"`, after `afterKey` when given. */
  scanPage(afterKey: string | undefined, limit: number): SqlStatement;
  /** Deletes the given ids of this collection. */
  deleteByIds(ids: string[]): SqlStatement;
}

const placeholders = (n: number): string => Array(n).fill('?').join(', ');

const limitClause = (limit?: number): string =>
  limit === undefined ? '' : ` LIMIT ${limit}`;

/** One table per collection: the 30.1.0 statements. */
export function perCollectionStoreSql(
  collection: string,
  dimension: number,
): HanaStoreSql {
  const table = quoteIdent(collection);
  return {
    layout: 'per-collection',
    createTable: () => createTableSql(collection, dimension),
    search: (lit, limit) => ({
      sql: `SELECT id AS "id", text AS "text", metadata AS "metadata", COSINE_SIMILARITY(vector, ${lit}) AS "score" FROM ${table} ORDER BY "score" DESC${limitClause(limit)}`,
      params: [],
    }),
    byId: (id) => ({
      sql: `SELECT id AS "id", text AS "text", metadata AS "metadata" FROM ${table} WHERE id = ?`,
      params: [id],
    }),
    upsert: (lit, id, text, metadataJson) => ({
      sql: `UPSERT ${table} (id, text, vector, metadata) VALUES (?, ?, ${lit}, ?) WITH PRIMARY KEY`,
      params: [id, text, metadataJson],
    }),
    deleteById: (id) => ({
      sql: `DELETE FROM ${table} WHERE id = ?`,
      params: [id],
    }),
    clear: () => ({ sql: `TRUNCATE TABLE ${table}`, params: [] }),
    countRows: () => ({
      sql: `SELECT COUNT(*) AS "n" FROM ${table}`,
      params: [],
    }),
    scanPage: (afterKey, limit) => ({
      sql: `SELECT "ID" AS "id", "TEXT" AS "text", "METADATA" AS "metadata" FROM ${table}${afterKey === undefined ? '' : ' WHERE "ID" > ?'} ORDER BY "ID" LIMIT ${limit}`,
      params: afterKey === undefined ? [] : [afterKey],
    }),
    deleteByIds: (ids) => ({
      sql: `DELETE FROM ${table} WHERE "ID" IN (${placeholders(ids.length)})`,
      params: [...ids],
    }),
  };
}

/** One documents table for all collections, told apart by `"COLLECTION"`. */
export function sharedStoreSql(
  collection: string,
  documentsTable: string,
): HanaStoreSql {
  const table = quoteIdent(documentsTable);
  return {
    layout: 'shared',
    createTable: () => undefined,
    search: (lit, limit) => ({
      sql: `SELECT "ID" AS "id", "TEXT" AS "text", "METADATA" AS "metadata", COSINE_SIMILARITY("VECTOR", ${lit}) AS "score" FROM ${table} WHERE "COLLECTION" = ? ORDER BY "score" DESC${limitClause(limit)}`,
      params: [collection],
    }),
    byId: (id) => ({
      sql: `SELECT "ID" AS "id", "TEXT" AS "text", "METADATA" AS "metadata" FROM ${table} WHERE "COLLECTION" = ? AND "ID" = ?`,
      params: [collection, id],
    }),
    upsert: (lit, id, text, metadataJson) => ({
      sql: `UPSERT ${table} ("COLLECTION", "ID", "TEXT", "VECTOR", "METADATA") VALUES (?, ?, ?, ${lit}, ?) WITH PRIMARY KEY`,
      params: [collection, id, text, metadataJson],
    }),
    deleteById: (id) => ({
      sql: `DELETE FROM ${table} WHERE "COLLECTION" = ? AND "ID" = ?`,
      params: [collection, id],
    }),
    clear: () => ({
      sql: `DELETE FROM ${table} WHERE "COLLECTION" = ?`,
      params: [collection],
    }),
    countRows: () => ({
      sql: `SELECT COUNT(*) AS "n" FROM ${table} WHERE "COLLECTION" = ?`,
      params: [collection],
    }),
    scanPage: (afterKey, limit) => ({
      sql: `SELECT "ID" AS "id", "TEXT" AS "text", "METADATA" AS "metadata" FROM ${table} WHERE "COLLECTION" = ?${afterKey === undefined ? '' : ' AND "ID" > ?'} ORDER BY "ID" LIMIT ${limit}`,
      params: afterKey === undefined ? [collection] : [collection, afterKey],
    }),
    deleteByIds: (ids) => ({
      sql: `DELETE FROM ${table} WHERE "COLLECTION" = ? AND "ID" IN (${placeholders(ids.length)})`,
      params: [collection, ...ids],
    }),
  };
}
