// `codeForStatus` / `mapRerankResults` stay module-internal (`map-rerank.ts`):
// they are not in spec §5.3's API, and no consumer needs them.
export {
  type FetchLike,
  SAP_AICORE_DEFAULT_RESOURCE_GROUP,
  type SapAiCoreRelevanceConfig,
  SapAiCoreRelevanceDecision,
} from './sap-aicore-relevance-decision.js';
