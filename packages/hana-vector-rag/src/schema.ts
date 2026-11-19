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

export function createTableSql(
  collection: string,
  dimension: number,
  opts: { ifNotExists?: boolean } = {},
): string {
  const table = quoteIdent(collection);
  const clause = opts.ifNotExists === false ? '' : 'IF NOT EXISTS ';
  return `CREATE TABLE ${clause}${table} (
    id NVARCHAR(255) NOT NULL,
    fragment_ordinal INTEGER DEFAULT 0 NOT NULL,
    text NCLOB,
    vector REAL_VECTOR(${dimension}),
    metadata NCLOB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id, fragment_ordinal)
  )`;
}

export function dropTableSql(collection: string): string {
  return `DROP TABLE IF EXISTS ${quoteIdent(collection)}`;
}

/** HANA executes DDL in an anonymous block with DDL autocommit disabled. */
export function fragmentOrdinalMigrationSql(
  name: string,
  layout: 'per-collection' | 'shared' = 'per-collection',
): string {
  const table = quoteIdent(name);
  const keys = layout === 'shared' ? '"COLLECTION", "ID"' : '"ID"';
  return `DO BEGIN
  DECLARE ordinal_exists INTEGER;
  SELECT COUNT(*) INTO ordinal_exists FROM SYS.TABLE_COLUMNS
  WHERE SCHEMA_NAME = CURRENT_SCHEMA AND TABLE_NAME = '${name}' AND COLUMN_NAME = 'FRAGMENT_ORDINAL';
  IF :ordinal_exists = 0 THEN
    EXECUTE IMMEDIATE 'ALTER TABLE ${table} ADD ("FRAGMENT_ORDINAL" INTEGER DEFAULT 0 NOT NULL)';
    EXECUTE IMMEDIATE 'ALTER TABLE ${table} ALTER ("TEXT" NCLOB NULL)';
    EXECUTE IMMEDIATE 'ALTER TABLE ${table} DROP PRIMARY KEY';
    EXECUTE IMMEDIATE 'ALTER TABLE ${table} ADD PRIMARY KEY (${keys}, "FRAGMENT_ORDINAL")';
  END IF;
END`;
}
