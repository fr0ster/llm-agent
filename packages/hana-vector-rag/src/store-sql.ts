import type { RagIdentityFilter, RagScanFilter } from '@mcp-abap-adt/llm-agent';
import { createTableSql, fragmentTableName, quoteIdent } from './schema.js';

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
  ): SqlStatement;
  byId(id: string): SqlStatement;
  upsert(
    vectorLiteral: string,
    id: string,
    text: string,
    metadataJson: string,
  ): SqlStatement;
  removeFragments(id: string): SqlStatement;
  insertFragment(id: string, ordinal: number, literal: string): SqlStatement;
  deleteById(id: string): SqlStatement;
  clear(): SqlStatement;
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
  const fragments = quoteIdent(fragmentTableName(collection));
  return {
    listPage: (after, limit, includeText) =>
      listSql(table, [], after, limit, includeText),
    layout: 'per-collection',
    createTable: () => createTableSql(collection, dimension),
    search: (lit, limit, filter) =>
      rankedSearch(table, fragments, lit, limit, filter),
    removeFragments: (id) => ({
      sql: `DELETE FROM ${fragments} WHERE "ID" = ?`,
      params: [id],
    }),
    insertFragment: (id, ordinal, literal) => ({
      sql: `INSERT INTO ${fragments} ("ID", "ORDINAL", "VECTOR") VALUES (?, ?, ${literal})`,
      params: [id, ordinal],
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
    clear: () => ({ sql: `DELETE FROM ${table}`, params: [] }),
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
  const fragments = quoteIdent(fragmentTableName(documentsTable));
  return {
    listPage: (after, limit, includeText) =>
      listSql(table, [collection], after, limit, includeText),
    layout: 'shared',
    createTable: () => undefined,
    search: (lit, limit, filter) =>
      rankedSearch(table, fragments, lit, limit, filter, collection),
    removeFragments: (id) => ({
      sql: `DELETE FROM ${fragments} WHERE "COLLECTION" = ? AND "ID" = ?`,
      params: [collection, id],
    }),
    insertFragment: (id, ordinal, literal) => ({
      sql: `INSERT INTO ${fragments} ("COLLECTION", "ID", "ORDINAL", "VECTOR") VALUES (?, ?, ?, ${literal})`,
      params: [collection, id, ordinal],
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

function listSql(
  table: string,
  params: string[],
  after: string | undefined,
  limit: number,
  includeText: boolean,
): SqlStatement {
  const conditions: string[] = params.length ? ['"COLLECTION" = ?'] : [];
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
  fragments: string,
  vector: string,
  limit: number,
  filter: Parameters<HanaStoreSql['search']>[2],
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
  const fragmentScope =
    collection === undefined ? '' : ' WHERE f."COLLECTION" = ?';
  const documentScope =
    collection === undefined ? '' : ' AND d."COLLECTION" = ?';
  if (collection !== undefined) params.push(collection, collection);
  return {
    sql: `WITH eligible AS (
      SELECT "ID", COSINE_SIMILARITY("VECTOR", ${vector}) AS "score"
      FROM ${table} WHERE ${conditions.join(' AND ')}
    ), scores AS (
      SELECT "ID", "score" FROM eligible
      UNION ALL
      SELECT f."ID", COSINE_SIMILARITY(f."VECTOR", ${vector}) AS "score"
      FROM ${fragments} AS f INNER JOIN eligible AS e ON e."ID" = f."ID"${fragmentScope}
    ), winners AS (
      SELECT "ID", MAX("score") AS "score" FROM scores
      GROUP BY "ID" ORDER BY "score" DESC, "ID" LIMIT ${limit}
    )
    SELECT d."ID" AS "id", d."TEXT" AS "text", d."METADATA" AS "metadata", w."score"
    FROM winners AS w INNER JOIN ${table} AS d ON d."ID" = w."ID"${documentScope}
    ORDER BY w."score" DESC, w."ID"`,
    params,
  };
}
