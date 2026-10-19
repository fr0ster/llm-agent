import { createCatalogTableSql } from './catalog.js';
import { createExtensionSql, quoteIdent } from './schema.js';

/** Default table of the `shared` layout: one documents table for all collections. */
export const SHARED_DOCUMENTS_TABLE = 'rag_documents';
/** Default catalog table of the `shared` layout. */
export const SHARED_CATALOG_TABLE = 'rag_collections';
/** The vector dimension the shipped DDL file is generated for. */
export const SHIPPED_DIMENSION = 1536;

function sharedDocumentsSql(table: string, dimension: number): string {
  return `CREATE TABLE ${quoteIdent(table)} (
  "collection" VARCHAR(63) NOT NULL,
  "id" VARCHAR(255) NOT NULL,
  "text" TEXT,
  "vector" vector(${dimension}),
  "metadata" JSONB,
  "created_at" TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY ("collection", "id")
)`;
}

/** SQL script for the shared layout: extension, catalog, documents; each statement terminated. */
export function sharedLayoutSql(opts: {
  documentsTable?: string;
  catalogTable?: string;
  dimension: number;
}): string {
  return [
    createExtensionSql(),
    createCatalogTableSql(opts.catalogTable ?? SHARED_CATALOG_TABLE),
    sharedDocumentsSql(
      opts.documentsTable ?? SHARED_DOCUMENTS_TABLE,
      opts.dimension,
    ),
  ]
    .map((statement) => `${statement};`)
    .join('\n');
}
