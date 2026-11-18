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
  return `DROP TABLE IF EXISTS ${quoteIdent(collection)}`;
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
