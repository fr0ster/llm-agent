import {
  INVALID_ARGUMENT,
  RagError,
  type RagIdentityFilter,
  type RagScanFilter,
} from '@mcp-abap-adt/llm-agent';
import { createTableSql, qualifiedTable, quoteIdent } from './schema.js';

export type SqlStatement = { sql: string; params: unknown[] };

/** What a search narrows by, besides the collection. */
export interface PgSearchFilter {
  identity?: RagIdentityFilter;
  namespace?: string;
  /** Epoch seconds; a numeric `metadata.ttl` before it has expired. */
  nowSecs: number;
}

/** The SQL a `PgVectorRag` sends, per table layout. */
export interface PgStoreSql {
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
    filter: PgSearchFilter,
    candidates?: number,
  ): SqlStatement;
  byId(id: string): SqlStatement;
  upsert(
    vectorLiteral: string,
    id: string,
    text: string,
    metadataJson: string,
  ): SqlStatement;
  deleteById(id: string): SqlStatement;
  lockById(id: string): SqlStatement;
  deleteByIds(ids: string[]): SqlStatement;
  removeFragments(id: string): SqlStatement;
  insertFragments(
    id: string,
    literals: string[],
    metadataJson: string,
  ): SqlStatement;
  clear(): SqlStatement;
  lockForClear?(): string;
  countRows(): SqlStatement;
  /** One page ordered by binary `"id"`, after `afterKey` when given, narrowed by `filter`. */
  scanPage(
    afterKey: string | undefined,
    limit: number,
    filter?: RagScanFilter,
  ): SqlStatement;
  /** Locks the primary rows of records matching the filter. */
  deleteWhere(filter: RagScanFilter): SqlStatement;
}

/**
 * The scan/delete filter as strict conditions: `userId`, `sessionId` and
 * `namespace` match only a JSON string equal to the wanted value (a number or
 * boolean never matches), in both layouts. No expiry: a scan sees expired rows.
 */
function scanFilterConditions(
  filter: RagScanFilter | undefined,
  params: unknown[],
): string[] {
  const conditions: string[] = [];
  for (const key of ['userId', 'sessionId', 'namespace'] as const) {
    const want = filter?.[key];
    if (want === undefined) continue;
    params.push(want);
    conditions.push(
      `CASE WHEN jsonb_typeof("metadata"->'${key}') = 'string' THEN "metadata"->>'${key}' END = $${params.length}`,
    );
  }
  return conditions;
}

/**
 * The primary key, in its own (default) collation: ORDER BY and the cursor
 * comparison use the same one, so the order is a stable total order and the
 * primary-key index serves every page. No COLLATE: it would defeat the index.
 */
const KEY = '"id"';

/** `params` already holds the collection (shared) or nothing (per-collection). */
function scanSql(
  table: string,
  params: unknown[],
  afterKey: string | undefined,
  limit: number,
  filter: RagScanFilter | undefined,
): SqlStatement {
  const conditions = ['"fragment_ordinal" = 0'];
  if (params.length > 0) conditions.push('"collection" = $1');
  if (afterKey !== undefined) {
    params.push(afterKey);
    conditions.push(`${KEY} > $${params.length}`);
  }
  conditions.push(...scanFilterConditions(filter, params));
  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
  return {
    sql: `SELECT "id", "text", "metadata" FROM ${table}${where} ORDER BY ${KEY} LIMIT ${limit}`,
    params,
  };
}

function deleteWhereSql(
  table: string,
  params: unknown[],
  filter: RagScanFilter,
): SqlStatement {
  const conditions = ['"fragment_ordinal" = 0'];
  if (params.length > 0) conditions.push('"collection" = $1');
  const strict = scanFilterConditions(filter, params);
  if (strict.length === 0)
    throw new RagError(
      'deleteWhere requires a non-empty filter',
      INVALID_ARGUMENT,
    );
  conditions.push(...strict);
  return {
    sql: `SELECT "id" FROM ${table} WHERE ${conditions.join(' AND ')} ORDER BY "id" FOR UPDATE`,
    params,
  };
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
 * `stringsOnly` (shared layout): the identity and namespace keys match only a
 * JSON string, as HANA's strict `matchesRagIdentity` does - `->>` alone would
 * coerce a JSON number or boolean to text, so `{ userId: 123 }` would match
 * `'123'`. The CASE yields NULL for a non-string, and NULL = $n is not true.
 */
function filterConditions(
  filter: PgSearchFilter,
  params: unknown[],
  metadata: string,
  stringsOnly = true,
): string[] {
  const conditions: string[] = [];
  const text = (key: string): string =>
    stringsOnly
      ? `CASE WHEN jsonb_typeof(${metadata}->'${key}') = 'string' THEN ${metadata}->>'${key}' END`
      : `${metadata}->>'${key}'`;
  if (filter.identity?.ownerScope !== undefined) {
    params.push(filter.identity.ownerScope);
    conditions.push(`${text('ownerScope')} = $${params.length}`);
  }
  if (filter.identity?.sessionId !== undefined) {
    params.push(filter.identity.sessionId);
    conditions.push(`${text('sessionId')} = $${params.length}`);
  }
  if (filter.identity?.userId !== undefined) {
    params.push(filter.identity.userId);
    conditions.push(`${text('userId')} = $${params.length}`);
  }
  if (filter.identity) {
    for (const key of ['sessionId', 'userId', 'roleId'] as const) {
      const required =
        (key === 'sessionId' && filter.identity.ownerScope === 'session') ||
        (key === 'userId' && filter.identity.ownerScope === 'user');
      conditions.push(
        required
          ? `${text(key)} ~ '[^[:space:]]'`
          : `NOT COALESCE(jsonb_exists(${metadata}, '${key}'), false)`,
      );
    }
  }
  if (typeof filter.namespace === 'string') {
    params.push(filter.namespace);
    conditions.push(`${text('namespace')} = $${params.length}`);
  }
  params.push(filter.nowSecs);
  conditions.push(
    `COALESCE(CASE WHEN jsonb_typeof(${metadata}->'ttl') = 'number' THEN (${metadata}->>'ttl')::float8 END, 'infinity'::float8) >= $${params.length}`,
  );
  return conditions;
}

/** The ordered candidate scan can use the existing cosine index. */
function rankedSearch(
  table: string,
  lit: string,
  limit: number,
  where: string,
  shared: boolean,
  candidates?: number,
): string {
  const recordScope = shared ? ' AND d."collection" = $1' : '';
  const distance = `"vector" <=> ${lit}`;
  const nearest =
    candidates === undefined ? '' : ` ORDER BY ${distance} LIMIT ${candidates}`;
  return `WITH candidate_rows AS MATERIALIZED (
    SELECT "id", ${distance} AS distance FROM ${table}
    WHERE ${where} AND "vector" IS NOT NULL${nearest}
  ), ranked AS (
    SELECT id, MIN(distance) AS distance, COUNT(*) AS fragments
    FROM candidate_rows GROUP BY id
  ), stats AS (
    SELECT COUNT(*) AS records, COALESCE(SUM(fragments), 0) AS candidates FROM ranked
  ), winners AS (
    SELECT id, distance FROM ranked ORDER BY distance, id LIMIT ${limit}
  )
  SELECT d."id", d."text", d."metadata", w.distance AS score, s.candidates AS "candidateCount"
  FROM stats AS s
  LEFT JOIN winners AS w ON ${candidates === undefined ? 'TRUE' : `s.records >= ${limit}`}
  LEFT JOIN ${table} AS d ON d."id" = w.id AND d."fragment_ordinal" = 0${recordScope}
  ORDER BY w.distance, w.id`;
}

/** One table per collection: the 30.1.0 statements. */
export function perCollectionStoreSql(
  collection: string,
  dimension: number,
): PgStoreSql {
  const table = quoteIdent(collection);
  return {
    listPage: (after, limit, includeText, filter) =>
      listSql(table, [], after, limit, includeText, filter),
    layout: 'per-collection',
    createTable: () => createTableSql(collection, dimension),
    search: (lit, limit, filter, candidates) => {
      const params: unknown[] = [];
      const where = filterConditions(filter, params, 'metadata').join(' AND ');
      return {
        sql: rankedSearch(table, lit, limit, where, false, candidates),
        params,
      };
    },
    byId: (id) => ({
      sql: `SELECT id, text, metadata FROM ${table} WHERE id = $1 AND fragment_ordinal = 0`,
      params: [id],
    }),
    upsert: (lit, id, text, metadataJson) => ({
      sql: `INSERT INTO ${table} (id, text, vector, metadata) VALUES ($1, $2, ${lit}, $3::jsonb) ON CONFLICT (id, fragment_ordinal) DO UPDATE SET text = EXCLUDED.text, vector = EXCLUDED.vector, metadata = EXCLUDED.metadata`,
      params: [id, text, metadataJson],
    }),
    removeFragments: (id) => ({
      sql: `DELETE FROM ${table} WHERE id = $1 AND fragment_ordinal > 0`,
      params: [id],
    }),
    insertFragments: (id, literals, metadataJson) => ({
      sql: `INSERT INTO ${table} (id, fragment_ordinal, vector, metadata)
        SELECT $1, ordinal, fragment::vector, $3::jsonb FROM unnest($2::text[]) WITH ORDINALITY AS vectors(fragment, ordinal)`,
      params: [id, literals, metadataJson],
    }),
    lockById: (id) => ({
      sql: `SELECT "id" FROM ${table} WHERE id = $1 AND fragment_ordinal = 0 FOR UPDATE`,
      params: [id],
    }),
    deleteByIds: (ids) => ({
      sql: `DELETE FROM ${table} WHERE id = ANY($1::varchar[])`,
      params: [ids],
    }),
    deleteById: (id) => ({
      sql: `DELETE FROM ${table} WHERE id = $1`,
      params: [id],
    }),
    clear: () => ({ sql: `TRUNCATE ${table}`, params: [] }),
    countRows: () => ({
      sql: `SELECT COUNT(*) AS n FROM ${table} WHERE fragment_ordinal = 0`,
      params: [],
    }),
    scanPage: (afterKey, limit, filter) =>
      scanSql(table, [], afterKey, limit, filter),
    deleteWhere: (filter) => deleteWhereSql(table, [], filter),
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
    listPage: (after, limit, includeText, filter) =>
      listSql(table, [collection], after, limit, includeText, filter),
    layout: 'shared',
    createTable: () => undefined,
    search: (lit, limit, filter, candidates) => {
      const params: unknown[] = [collection];
      const where = [
        '"collection" = $1',
        ...filterConditions(filter, params, '"metadata"', true),
      ].join(' AND ');
      return {
        sql: rankedSearch(table, lit, limit, where, true, candidates),
        params,
      };
    },
    byId: (id) => ({
      sql: `SELECT "id", "text", "metadata" FROM ${table} WHERE "collection" = $1 AND "id" = $2 AND "fragment_ordinal" = 0`,
      params: [collection, id],
    }),
    upsert: (lit, id, text, metadataJson) => ({
      sql: `INSERT INTO ${table} ("collection", "id", "text", "vector", "metadata") VALUES ($1, $2, $3, ${lit}, $4::jsonb) ON CONFLICT ("collection", "id", "fragment_ordinal") DO UPDATE SET "text" = EXCLUDED."text", "vector" = EXCLUDED."vector", "metadata" = EXCLUDED."metadata"`,
      params: [collection, id, text, metadataJson],
    }),
    removeFragments: (id) => ({
      sql: `DELETE FROM ${table} WHERE "collection" = $1 AND "id" = $2 AND "fragment_ordinal" > 0`,
      params: [collection, id],
    }),
    insertFragments: (id, literals, metadataJson) => ({
      sql: `INSERT INTO ${table} ("collection", "id", "fragment_ordinal", "vector", "metadata")
        SELECT $1, $2, ordinal, fragment::vector, $4::jsonb FROM unnest($3::text[]) WITH ORDINALITY AS vectors(fragment, ordinal)`,
      params: [collection, id, literals, metadataJson],
    }),
    lockById: (id) => ({
      sql: `SELECT "id" FROM ${table} WHERE "collection" = $1 AND "id" = $2 AND "fragment_ordinal" = 0 FOR UPDATE`,
      params: [collection, id],
    }),
    deleteByIds: (ids) => ({
      sql: `DELETE FROM ${table} WHERE "collection" = $1 AND "id" = ANY($2::varchar[])`,
      params: [collection, ids],
    }),
    deleteById: (id) => ({
      sql: `DELETE FROM ${table} WHERE "collection" = $1 AND "id" = $2`,
      params: [collection, id],
    }),
    lockForClear: () => `LOCK TABLE ${table} IN EXCLUSIVE MODE`,
    clear: () => ({
      sql: `DELETE FROM ${table} WHERE "collection" = $1`,
      params: [collection],
    }),
    countRows: () => ({
      sql: `SELECT COUNT(*) AS n FROM ${table} WHERE "collection" = $1 AND "fragment_ordinal" = 0`,
      params: [collection],
    }),
    scanPage: (afterKey, limit, filter) =>
      scanSql(table, [collection], afterKey, limit, filter),
    deleteWhere: (filter) => deleteWhereSql(table, [collection], filter),
  };
}

function listSql(
  table: string,
  params: string[],
  after: string | undefined,
  limit: number,
  includeText: boolean,
  filter?: RagScanFilter,
): SqlStatement {
  const conditions = ['"fragment_ordinal" = 0'];
  if (params.length) conditions.push('"collection" = $1');
  if (after !== undefined) {
    params.push(after);
    conditions.push(`"id" COLLATE "C" > $${params.length} COLLATE "C"`);
  }
  conditions.push(...scanFilterConditions(filter, params));
  return {
    sql: `SELECT "id", "metadata"${includeText ? ', "text"' : ''} FROM ${table}${conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''} ORDER BY "id" COLLATE "C" LIMIT ${limit}`,
    params,
  };
}
