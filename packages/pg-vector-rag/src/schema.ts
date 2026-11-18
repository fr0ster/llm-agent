import { createHash } from 'node:crypto';
import { RagError } from '@mcp-abap-adt/llm-agent';

const COLLECTION_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;

export function assertCollectionName(name: string): void {
  if (!COLLECTION_NAME_RE.test(name)) {
    throw new RagError(
      `Invalid collection name: ${name}`,
      'INVALID_COLLECTION_NAME',
    );
  }
}

export function quoteIdent(ident: string): string {
  assertCollectionName(ident);
  return `"${ident}"`;
}

export function createExtensionSql(): string {
  return 'CREATE EXTENSION IF NOT EXISTS vector';
}

export function createTableSql(
  collection: string,
  dimension: number,
  opts: { ifNotExists?: boolean } = {},
): string {
  const table = quoteIdent(collection);
  const clause = opts.ifNotExists === false ? '' : 'IF NOT EXISTS ';
  return `CREATE TABLE ${clause}${table} (
    id VARCHAR(255) PRIMARY KEY,
    text TEXT,
    vector vector(${dimension}),
    fragment_vectors vector(${dimension})[],
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`;
}

export function dropTableSql(collection: string): string {
  return `DROP TABLE IF EXISTS ${quoteIdent(collection)}, ${quoteIdent(fragmentTableName(collection))}`;
}

/**
 * The quoted name of a table, schema-qualified when a schema is given; else it
 * resolves through the search_path. Both are validated like table names.
 */
export function qualifiedTable(table: string, schema?: string): string {
  return schema === undefined
    ? quoteIdent(table)
    : `${quoteIdent(schema)}.${quoteIdent(table)}`;
}

/** Adds fragment storage to an existing table while preserving its primary vectors. */
export function addFragmentVectorsSql(table: string, schema?: string): string {
  return `ALTER TABLE ${qualifiedTable(table, schema)} ADD COLUMN IF NOT EXISTS "fragment_vectors" vector[]`;
}

/** Keep derived names distinct even when a document table uses all 63 bytes. */
export function fragmentTableName(table: string): string {
  const suffix = '_fragments';
  if (table.length + suffix.length <= 63) return table + suffix;
  const hash = createHash('sha256').update(table).digest('hex').slice(0, 16);
  return `${table.slice(0, 36)}_${hash}${suffix}`;
}

/** Projection of document vectors into indexable rows. The trigger runs in the parent write. */
export function fragmentStorageSql(
  table: string,
  dimension: number,
  layout: 'shared' | 'per-collection' = 'per-collection',
  schema?: string,
): string[] {
  const shared = layout === 'shared';
  const parent = qualifiedTable(table, schema);
  const name = fragmentTableName(table);
  const fragments = qualifiedTable(name, schema);
  const sync = qualifiedTable(fragmentTableName(name), schema);
  const collectionColumn = shared ? '"collection" VARCHAR(63) NOT NULL, ' : '';
  const collectionKey = shared ? '"collection", ' : '';
  const collectionValue = shared ? 'NEW."collection", ' : '';
  const collectionMatch = shared ? '"collection" = NEW."collection" AND ' : '';
  return [
    addFragmentVectorsSql(table, schema),
    `CREATE TABLE IF NOT EXISTS ${fragments} (
      ${collectionColumn}"id" VARCHAR(255) NOT NULL,
      "ordinal" BIGINT NOT NULL,
      "vector" vector(${dimension}) NOT NULL,
      PRIMARY KEY (${collectionKey}"id", "ordinal"),
      FOREIGN KEY (${collectionKey}"id") REFERENCES ${parent} (${collectionKey}"id") ON DELETE CASCADE
    )`,
    ...(dimension <= 2000
      ? [
          `CREATE INDEX IF NOT EXISTS ${quoteIdent(fragmentTableName(fragmentTableName(name)))} ON ${fragments} USING hnsw ("vector" vector_cosine_ops)`,
        ]
      : []),
    `CREATE OR REPLACE FUNCTION ${sync}() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $sync$
    BEGIN
      DELETE FROM ${fragments} WHERE ${collectionMatch}"id" = NEW."id";
      INSERT INTO ${fragments} (${collectionKey}"id", "ordinal", "vector")
      SELECT ${collectionValue}NEW."id", ordinal, fragment
      FROM unnest(NEW."fragment_vectors") WITH ORDINALITY AS vectors(fragment, ordinal);
      RETURN NEW;
    END;
    $sync$`,
    `DROP TRIGGER IF EXISTS "sync_rag_fragments" ON ${parent}`,
    `CREATE TRIGGER "sync_rag_fragments"
    AFTER INSERT OR UPDATE OF "fragment_vectors" ON ${parent}
    FOR EACH ROW EXECUTE FUNCTION ${sync}()`,
    `INSERT INTO ${fragments} (${collectionKey}"id", "ordinal", "vector")
    SELECT ${collectionKey}"id", ordinal, fragment
    FROM ${parent} CROSS JOIN LATERAL unnest("fragment_vectors") WITH ORDINALITY AS vectors(fragment, ordinal)
    ON CONFLICT DO NOTHING`,
  ];
}
