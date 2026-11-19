import type { RagIdentityFilter, RagScanFilter } from '@mcp-abap-adt/llm-agent';
import { createTableSql, quoteIdent } from './schema.js';

export type SqlStatement = { sql: string; params: unknown[] };

/** The SQL a `HanaVectorRag` sends, per table layout. */
export interface HanaStoreSql {
  listPage(
    after: string | undefined,
    limit: number,
    includeText: boolean,
    filter?: RagScanFilter,
  ): SqlStatement;
  readonly layout: 'per-collection' | 'shared';
  /** `undefined` in `shared`: no DDL ever reaches the client. */
  createTable(): string | undefined;
  search(
    vectorLiteral: string,
    limit: number,
    filter: {
      identity?: RagIdentityFilter;
      namespace?: string;
      nowSecs: number;
    },
    candidates?: number,
  ): SqlStatement;
  byId(id: string): SqlStatement;
  upsert(
    vectorLiteral: string,
    id: string,
    text: string,
    metadataJson: string,
  ): SqlStatement;
  removeFragments(id: string): SqlStatement;
  insertFragment(
    id: string,
    ordinal: number,
    literal: string,
    metadataJson: string,
  ): SqlStatement;
  lockByIds(ids: string[]): SqlStatement;
  deleteById(id: string): SqlStatement;
  clear(): SqlStatement;
  lockForClear(): string;
  countRows(): SqlStatement;
  /** One page of rows ordered by `"ID"`, after `afterKey` when given. */
  scanPage(afterKey: string | undefined, limit: number): SqlStatement;
  /** Deletes the given ids of this collection. */
  deleteByIds(ids: string[]): SqlStatement;
}

const placeholders = (n: number): string => Array(n).fill('?').join(', ');

/** One table per collection: the 30.1.0 statements. */
export function perCollectionStoreSql(
  collection: string,
  dimension: number,
): HanaStoreSql {
  const table = quoteIdent(collection);
  return {
    listPage: (after, limit, includeText) =>
      listSql(table, [], after, limit, includeText),
    layout: 'per-collection',
    createTable: () => createTableSql(collection, dimension),
    search: (lit, limit, filter, candidates) =>
      rankedSearch(table, lit, limit, filter, candidates),
    removeFragments: (id) => ({
      sql: `DELETE FROM ${table} WHERE "ID" = ? AND "FRAGMENT_ORDINAL" > 0`,
      params: [id],
    }),
    insertFragment: (id, ordinal, literal, metadataJson) => ({
      sql: `INSERT INTO ${table} ("ID", "FRAGMENT_ORDINAL", "VECTOR", "METADATA") VALUES (?, ?, ${literal}, ?)`,
      params: [id, ordinal, metadataJson],
    }),
    byId: (id) => ({
      sql: `SELECT id AS "id", text AS "text", metadata AS "metadata" FROM ${table} WHERE id = ? AND "FRAGMENT_ORDINAL" = 0`,
      params: [id],
    }),
    upsert: (lit, id, text, metadataJson) => ({
      sql: `UPSERT ${table} (id, text, vector, metadata, fragment_ordinal) VALUES (?, ?, ${lit}, ?, 0) WITH PRIMARY KEY`,
      params: [id, text, metadataJson],
    }),
    deleteById: (id) => ({
      sql: `DELETE FROM ${table} WHERE id = ?`,
      params: [id],
    }),
    lockForClear: () => `LOCK TABLE ${table} IN EXCLUSIVE MODE`,
    clear: () => ({ sql: `DELETE FROM ${table}`, params: [] }),
    countRows: () => ({
      sql: `SELECT COUNT(*) AS "n" FROM ${table} WHERE "FRAGMENT_ORDINAL" = 0`,
      params: [],
    }),
    scanPage: (afterKey, limit) => ({
      sql: `SELECT "ID" AS "id", "TEXT" AS "text", "METADATA" AS "metadata" FROM ${table} WHERE "FRAGMENT_ORDINAL" = 0${afterKey === undefined ? '' : ' AND "ID" > ?'} ORDER BY "ID" LIMIT ${limit}`,
      params: afterKey === undefined ? [] : [afterKey],
    }),
    lockByIds: (ids) => ({
      sql: `SELECT "ID" AS "id", "METADATA" AS "metadata" FROM ${table} WHERE "FRAGMENT_ORDINAL" = 0 AND "ID" IN (${placeholders(ids.length)}) ORDER BY "ID" FOR UPDATE`,
      params: [...ids],
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
    listPage: (after, limit, includeText) =>
      listSql(table, [collection], after, limit, includeText),
    layout: 'shared',
    createTable: () => undefined,
    search: (lit, limit, filter, candidates) =>
      rankedSearch(table, lit, limit, filter, candidates, collection),
    removeFragments: (id) => ({
      sql: `DELETE FROM ${table} WHERE "COLLECTION" = ? AND "ID" = ? AND "FRAGMENT_ORDINAL" > 0`,
      params: [collection, id],
    }),
    insertFragment: (id, ordinal, literal, metadataJson) => ({
      sql: `INSERT INTO ${table} ("COLLECTION", "ID", "FRAGMENT_ORDINAL", "VECTOR", "METADATA") VALUES (?, ?, ?, ${literal}, ?)`,
      params: [collection, id, ordinal, metadataJson],
    }),
    byId: (id) => ({
      sql: `SELECT "ID" AS "id", "TEXT" AS "text", "METADATA" AS "metadata" FROM ${table} WHERE "COLLECTION" = ? AND "ID" = ? AND "FRAGMENT_ORDINAL" = 0`,
      params: [collection, id],
    }),
    upsert: (lit, id, text, metadataJson) => ({
      sql: `UPSERT ${table} ("COLLECTION", "ID", "TEXT", "VECTOR", "METADATA", "FRAGMENT_ORDINAL") VALUES (?, ?, ?, ${lit}, ?, 0) WITH PRIMARY KEY`,
      params: [collection, id, text, metadataJson],
    }),
    deleteById: (id) => ({
      sql: `DELETE FROM ${table} WHERE "COLLECTION" = ? AND "ID" = ?`,
      params: [collection, id],
    }),
    lockForClear: () => `LOCK TABLE ${table} IN EXCLUSIVE MODE`,
    clear: () => ({
      sql: `DELETE FROM ${table} WHERE "COLLECTION" = ?`,
      params: [collection],
    }),
    countRows: () => ({
      sql: `SELECT COUNT(*) AS "n" FROM ${table} WHERE "COLLECTION" = ? AND "FRAGMENT_ORDINAL" = 0`,
      params: [collection],
    }),
    scanPage: (afterKey, limit) => ({
      sql: `SELECT "ID" AS "id", "TEXT" AS "text", "METADATA" AS "metadata" FROM ${table} WHERE "COLLECTION" = ? AND "FRAGMENT_ORDINAL" = 0${afterKey === undefined ? '' : ' AND "ID" > ?'} ORDER BY "ID" LIMIT ${limit}`,
      params: afterKey === undefined ? [collection] : [collection, afterKey],
    }),
    lockByIds: (ids) => ({
      sql: `SELECT "ID" AS "id", "METADATA" AS "metadata" FROM ${table} WHERE "COLLECTION" = ? AND "FRAGMENT_ORDINAL" = 0 AND "ID" IN (${placeholders(ids.length)}) ORDER BY "ID" FOR UPDATE`,
      params: [collection, ...ids],
    }),
    deleteByIds: (ids) => ({
      sql: `DELETE FROM ${table} WHERE "COLLECTION" = ? AND "ID" IN (${placeholders(ids.length)})`,
      params: [collection, ...ids],
    }),
  };
}

function listSql(
  table: string,
  params: string[],
  after: string | undefined,
  limit: number,
  includeText: boolean,
): SqlStatement {
  const conditions = ['"FRAGMENT_ORDINAL" = 0'];
  if (params.length) conditions.push('"COLLECTION" = ?');
  if (after !== undefined) {
    conditions.push('TO_BINARY("ID") > TO_BINARY(?)');
    params.push(after);
  }
  return {
    sql: `SELECT "ID" AS "id", "METADATA" AS "metadata"${includeText ? ', "TEXT" AS "text"' : ''} FROM ${table}${conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''} ORDER BY TO_BINARY("ID") LIMIT ${limit}`,
    params,
  };
}

/** Aggregate eligible fragment scores, then access document LOBs for the winners. */
function rankedSearch(
  table: string,
  vector: string,
  limit: number,
  filter: Parameters<HanaStoreSql['search']>[2],
  candidates?: number,
  collection?: string,
): SqlStatement {
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (collection !== undefined) {
    conditions.push('"COLLECTION" = ?');
    params.push(collection);
  }
  for (const [key, value] of Object.entries({
    ownerScope: filter.identity?.ownerScope,
    sessionId: filter.identity?.sessionId,
    userId: filter.identity?.userId,
    namespace: filter.namespace,
  })) {
    if (value === undefined) continue;
    conditions.push(
      `JSON_QUERY("METADATA", '$.${key}' WITH ARRAY WRAPPER) LIKE_REGEXPR '^\\[\\s*"' AND JSON_VALUE("METADATA", '$.${key}' RETURNING NVARCHAR(5000)) = ?`,
    );
    params.push(value);
  }
  if (filter.identity) {
    for (const key of ['sessionId', 'userId', 'roleId'] as const) {
      const required =
        (key === 'sessionId' && filter.identity.ownerScope === 'session') ||
        (key === 'userId' && filter.identity.ownerScope === 'user');
      conditions.push(
        required
          ? `JSON_VALUE("METADATA", '$.${key}' RETURNING NVARCHAR(5000)) LIKE_REGEXPR '\\S'`
          : `JSON_QUERY("METADATA", '$.${key}' WITH ARRAY WRAPPER) IS NULL`,
      );
    }
  }
  conditions.push(
    `COALESCE(CASE WHEN JSON_QUERY("METADATA", '$.ttl' WITH ARRAY WRAPPER) LIKE_REGEXPR '^\\[\\s*-?[0-9]' THEN JSON_VALUE("METADATA", '$.ttl' RETURNING DOUBLE) END, ?) >= ?`,
  );
  params.push(filter.nowSecs, filter.nowSecs);
  const documentScope =
    collection === undefined ? '' : ' AND d."COLLECTION" = ?';
  if (collection !== undefined) params.push(collection);
  const nearest =
    candidates === undefined
      ? ''
      : ` ORDER BY "score" DESC LIMIT ${candidates}`;
  return {
    sql: `WITH candidate_rows AS (
      SELECT "ID", COSINE_SIMILARITY("VECTOR", ${vector}) AS "score"
      FROM ${table} WHERE ${conditions.join(' AND ')} AND "VECTOR" IS NOT NULL${nearest}
    ), ranked AS (
      SELECT "ID", MAX("score") AS "score", COUNT(*) AS "fragments"
      FROM candidate_rows GROUP BY "ID"
    ), stats AS (
      SELECT COUNT(*) AS "records", COALESCE(SUM("fragments"), 0) AS "candidates" FROM ranked
    ), winners AS (
      SELECT "ID", "score" FROM ranked ORDER BY "score" DESC, "ID" LIMIT ${limit}
    )
    SELECT d."ID" AS "id", d."TEXT" AS "text", d."METADATA" AS "metadata", w."score", s."candidates" AS "candidateCount"
    FROM stats AS s
    LEFT JOIN winners AS w ON ${candidates === undefined ? '1 = 1' : `s."records" >= ${limit}`}
    LEFT JOIN ${table} AS d ON d."ID" = w."ID" AND d."FRAGMENT_ORDINAL" = 0${documentScope}
    ORDER BY w."score" DESC, w."ID"`,
    params,
  };
}
