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
    id VARCHAR(255) NOT NULL,
    fragment_ordinal INTEGER NOT NULL DEFAULT 0,
    text TEXT,
    vector vector(${dimension}),
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (id, fragment_ordinal)
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

/** Upgrade released tables in place, retaining the PK name and vector index. */
export function fragmentOrdinalMigrationSql(
  name: string,
  layout: 'per-collection' | 'shared' = 'per-collection',
  schema?: string,
): string {
  const table = qualifiedTable(name, schema);
  const keys = layout === 'shared' ? '"collection", "id"' : '"id"';
  return `DO $migration$
DECLARE
  pk_name text;
BEGIN
  IF NOT EXISTS (
    SELECT FROM pg_attribute WHERE attrelid = '${table}'::regclass
      AND attname = 'fragment_ordinal' AND NOT attisdropped
  ) THEN
    LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE;
    IF NOT EXISTS (
      SELECT FROM pg_attribute WHERE attrelid = '${table}'::regclass
        AND attname = 'fragment_ordinal' AND NOT attisdropped
    ) THEN
      SELECT conname INTO STRICT pk_name FROM pg_constraint
      WHERE conrelid = '${table}'::regclass AND contype = 'p';
      EXECUTE format('ALTER TABLE ${table} DROP CONSTRAINT %I, ADD COLUMN fragment_ordinal integer NOT NULL DEFAULT 0, ALTER COLUMN "text" DROP NOT NULL', pk_name);
      EXECUTE format('ALTER TABLE ${table} ADD CONSTRAINT %I PRIMARY KEY (${keys}, fragment_ordinal)', pk_name);
    END IF;
  END IF;
END
$migration$`;
}
