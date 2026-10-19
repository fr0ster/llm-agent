import { createTableSql, qualifiedTable, quoteIdent } from './schema.js';

export type SqlStatement = { sql: string; params: unknown[] };

/** What a search narrows by, besides the collection. */
export interface PgSearchFilter {
  identity?: { sessionId?: string; userId?: string };
  namespace?: string;
  /** Epoch seconds; a numeric `metadata.ttl` before it has expired. */
  nowSecs: number;
}

/** The SQL a `PgVectorRag` sends, per table layout. */
export interface PgStoreSql {
  readonly layout: 'per-collection' | 'shared';
  /** `undefined` in `shared`: no DDL ever reaches the client. */
  createTable(): string | undefined;
  search(
    vectorLiteral: string,
    limit: number,
    filter: PgSearchFilter,
  ): SqlStatement;
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
}

/**
 * The filters, as parameterised conditions on the jsonb metadata (never
 * interpolated) — the same contract VectorRag / QdrantRag apply:
 * - session/user scope: `->>` yields NULL for a missing key, and
 *   NULL = $n is not true, so an unowned row is excluded;
 * - `namespace`: the same, on `metadata.namespace`;
 * - expiry: a numeric `metadata.ttl` (epoch seconds) in the past drops the
 *   row; a missing or non-numeric ttl never expires. The CASE keeps the float8
 *   cast away from a non-numeric value, which would fail the whole query.
 * `params` already holds what comes before them (the shared `collection`).
 */
function filterConditions(
  filter: PgSearchFilter,
  params: unknown[],
  metadata: string,
): string[] {
  const conditions: string[] = [];
  if (filter.identity?.sessionId !== undefined) {
    params.push(filter.identity.sessionId);
    conditions.push(`${metadata}->>'sessionId' = $${params.length}`);
  }
  if (filter.identity?.userId !== undefined) {
    params.push(filter.identity.userId);
    conditions.push(`${metadata}->>'userId' = $${params.length}`);
  }
  if (typeof filter.namespace === 'string') {
    params.push(filter.namespace);
    conditions.push(`${metadata}->>'namespace' = $${params.length}`);
  }
  params.push(filter.nowSecs);
  conditions.push(
    `COALESCE(CASE WHEN jsonb_typeof(${metadata}->'ttl') = 'number' THEN (${metadata}->>'ttl')::float8 END, 'infinity'::float8) >= $${params.length}`,
  );
  return conditions;
}

/** One table per collection: the 30.1.0 statements. */
export function perCollectionStoreSql(
  collection: string,
  dimension: number,
): PgStoreSql {
  const table = quoteIdent(collection);
  return {
    layout: 'per-collection',
    createTable: () => createTableSql(collection, dimension),
    search: (lit, limit, filter) => {
      const params: unknown[] = [];
      const where = filterConditions(filter, params, 'metadata').join(' AND ');
      return {
        sql: `SELECT id, text, metadata, vector <=> ${lit} AS score FROM ${table} WHERE ${where} ORDER BY vector <=> ${lit} LIMIT ${limit}`,
        params,
      };
    },
    byId: (id) => ({
      sql: `SELECT id, text, metadata FROM ${table} WHERE id = $1`,
      params: [id],
    }),
    upsert: (lit, id, text, metadataJson) => ({
      sql: `INSERT INTO ${table} (id, text, vector, metadata) VALUES ($1, $2, ${lit}, $3::jsonb) ON CONFLICT (id) DO UPDATE SET text = EXCLUDED.text, vector = EXCLUDED.vector, metadata = EXCLUDED.metadata`,
      params: [id, text, metadataJson],
    }),
    deleteById: (id) => ({
      sql: `DELETE FROM ${table} WHERE id = $1`,
      params: [id],
    }),
    clear: () => ({ sql: `TRUNCATE ${table}`, params: [] }),
    countRows: () => ({
      sql: `SELECT COUNT(*) AS n FROM ${table}`,
      params: [],
    }),
  };
}

/** One documents table for all collections, told apart by `"collection"`. */
export function sharedStoreSql(
  collection: string,
  documentsTable: string,
  schema?: string,
): PgStoreSql {
  const table = qualifiedTable(documentsTable, schema);
  return {
    layout: 'shared',
    createTable: () => undefined,
    search: (lit, limit, filter) => {
      const params: unknown[] = [collection];
      const where = [
        '"collection" = $1',
        ...filterConditions(filter, params, '"metadata"'),
      ].join(' AND ');
      return {
        sql: `SELECT "id", "text", "metadata", "vector" <=> ${lit} AS score FROM ${table} WHERE ${where} ORDER BY "vector" <=> ${lit} LIMIT ${limit}`,
        params,
      };
    },
    byId: (id) => ({
      sql: `SELECT "id", "text", "metadata" FROM ${table} WHERE "collection" = $1 AND "id" = $2`,
      params: [collection, id],
    }),
    upsert: (lit, id, text, metadataJson) => ({
      sql: `INSERT INTO ${table} ("collection", "id", "text", "vector", "metadata") VALUES ($1, $2, $3, ${lit}, $4::jsonb) ON CONFLICT ("collection", "id") DO UPDATE SET "text" = EXCLUDED."text", "vector" = EXCLUDED."vector", "metadata" = EXCLUDED."metadata"`,
      params: [collection, id, text, metadataJson],
    }),
    deleteById: (id) => ({
      sql: `DELETE FROM ${table} WHERE "collection" = $1 AND "id" = $2`,
      params: [collection, id],
    }),
    clear: () => ({
      sql: `DELETE FROM ${table} WHERE "collection" = $1`,
      params: [collection],
    }),
    countRows: () => ({
      sql: `SELECT COUNT(*) AS n FROM ${table} WHERE "collection" = $1`,
      params: [collection],
    }),
  };
}
