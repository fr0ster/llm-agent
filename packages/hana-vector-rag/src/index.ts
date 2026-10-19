export { createCatalogTableSql, DEFAULT_CATALOG_TABLE } from './catalog.js';
export {
  INVALID_CONFIG,
  INVALID_VECTOR,
  SHARED_LAYOUT_NOT_DEPLOYED,
} from './error-codes.js';
export type { HanaVectorRagConfig } from './hana-vector-rag.js';
export { createHanaClient, HanaVectorRag } from './hana-vector-rag.js';
export type { HanaVectorRagProviderConfig } from './hana-vector-rag-provider.js';
export { HanaVectorRagProvider } from './hana-vector-rag-provider.js';
export {
  SHARED_CATALOG_TABLE,
  SHARED_DOCUMENTS_TABLE,
  SHIPPED_DIMENSION,
  sharedCatalogHdbtable,
  sharedDocumentsHdbtable,
  sharedLayoutSql,
} from './shared-ddl.js';
