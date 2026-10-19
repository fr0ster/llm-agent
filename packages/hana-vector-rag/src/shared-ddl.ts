import { catalogColumnsSql } from './catalog.js';
import { quoteIdent } from './schema.js';

/** Default table of the `shared` layout: one documents table for all collections. */
export const SHARED_DOCUMENTS_TABLE = 'RAG_DOCUMENTS';
/** Default catalog table of the `shared` layout. */
export const SHARED_CATALOG_TABLE = 'RAG_COLLECTIONS';
/** The vector dimension the shipped DDL files are generated for. */
export const SHIPPED_DIMENSION = 1536;

/** Body of an HDI `.hdbtable` file for the shared documents table. */
export function sharedDocumentsHdbtable(
  table: string,
  dimension: number,
): string {
  return `COLUMN TABLE ${quoteIdent(table)} (
  "COLLECTION" NVARCHAR(63) NOT NULL,
  "ID" NVARCHAR(255) NOT NULL,
  "TEXT" NCLOB,
  "VECTOR" REAL_VECTOR(${dimension}),
  "METADATA" NCLOB,
  "CREATED_AT" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("COLLECTION", "ID")
)`;
}

/** Body of an HDI `.hdbtable` file for the catalog table. */
export function sharedCatalogHdbtable(table: string): string {
  return `COLUMN TABLE ${quoteIdent(table)} (
${catalogColumnsSql()}
  )`;
}

/** Plain SQL script for an operator who does not use HDI: catalog first, each statement terminated. */
export function sharedLayoutSql(opts: {
  documentsTable?: string;
  catalogTable?: string;
  dimension: number;
}): string {
  const documents = sharedDocumentsHdbtable(
    opts.documentsTable ?? SHARED_DOCUMENTS_TABLE,
    opts.dimension,
  );
  const catalog = sharedCatalogHdbtable(
    opts.catalogTable ?? SHARED_CATALOG_TABLE,
  );
  return `CREATE ${catalog};\nCREATE ${documents};`;
}
