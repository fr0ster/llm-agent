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

export function createTableSql(
  collection: string,
  dimension: number,
  opts: { ifNotExists?: boolean } = {},
): string {
  const table = quoteIdent(collection);
  const clause = opts.ifNotExists === false ? '' : 'IF NOT EXISTS ';
  return `CREATE TABLE ${clause}${table} (
    id NVARCHAR(255) PRIMARY KEY,
    text NCLOB,
    vector REAL_VECTOR(${dimension}),
    metadata NCLOB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`;
}

export function dropTableSql(collection: string): string {
  return `DROP TABLE IF EXISTS ${quoteIdent(collection)}`;
}

/** Adds fragment storage to an existing table while preserving its primary vectors. */
export function addFragmentVectorsSql(table: string): string {
  return `ALTER TABLE ${quoteIdent(table)} ADD ("FRAGMENT_VECTORS" NCLOB)`;
}

export function fragmentTableName(table: string): string {
  const hash = createHash('sha256').update(table).digest('hex').slice(0, 16);
  return table.length <= 53
    ? `${table}_FRAGMENTS`
    : `${table.slice(0, 36)}_${hash}_FRAGMENTS`;
}

export function fragmentTableDdl(
  table: string,
  dimension: number,
  layout: 'shared' | 'per-collection' = 'per-collection',
  includeForeignKey = true,
): string {
  const shared = layout === 'shared';
  const key = shared ? '"COLLECTION", "ID"' : '"ID"';
  return `COLUMN TABLE ${quoteIdent(fragmentTableName(table))} (
  ${shared ? '"COLLECTION" NVARCHAR(63) NOT NULL,\n  ' : ''}"ID" NVARCHAR(255) NOT NULL,
  "ORDINAL" INTEGER NOT NULL,
  "VECTOR" REAL_VECTOR(${dimension}) NOT NULL,
  PRIMARY KEY (${key}, "ORDINAL")${includeForeignKey ? `,\n  FOREIGN KEY (${key}) REFERENCES ${quoteIdent(table)} (${key}) ON DELETE CASCADE` : ''}
)`;
}
