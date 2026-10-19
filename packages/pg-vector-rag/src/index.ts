export { createCatalogTableSql, DEFAULT_CATALOG_TABLE } from './catalog.js';
export type { PgVectorRagConfig } from './pg-vector-rag.js';
export { createPgClient, PgVectorRag } from './pg-vector-rag.js';
export type { PgVectorRagProviderConfig } from './pg-vector-rag-provider.js';
export { PgVectorRagProvider } from './pg-vector-rag-provider.js';
export {
  SHARED_CATALOG_TABLE,
  SHARED_DOCUMENTS_TABLE,
  SHIPPED_DIMENSION,
  sharedLayoutSql,
} from './shared-ddl.js';
