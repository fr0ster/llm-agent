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

export function createTableSql(collection: string, dimension: number): string {
  const table = quoteIdent(collection);
  return `CREATE TABLE IF NOT EXISTS ${table} (
    id VARCHAR(255) PRIMARY KEY,
    text TEXT,
    vector vector(${dimension}),
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`;
}

export function dropTableSql(collection: string): string {
  return `DROP TABLE IF EXISTS ${quoteIdent(collection)}`;
}
