// The RAG implementations (spec §11.3, D57) — this package's own files.
export { ActiveFilteringRag } from './active-filtering-rag.js';
export {
  _resetPrefetchedForTests,
  type BuiltInEmbedderResolution,
  type EmbedderResolution,
  prefetchEmbedderFactories,
} from './embedder-factories.js';
export { InMemoryRag, type InMemoryRagConfig } from './in-memory-rag.js';
export {
  buildRagCollectionToolEntries,
  type RagCallerIdentity,
  type RagCollectionToolOptions,
  type RagToolContext,
  type RagToolEntry,
} from './mcp-tools/index.js';
export { OverlayRag, SessionScopedRag } from './overlays/index.js';
export {
  ExpandPreprocessor,
  IntentEnricher,
  NoopDocumentEnricher,
  NoopQueryPreprocessor,
  PreprocessorChain,
  TranslatePreprocessor,
} from './preprocessor.js';
export {
  InMemoryRagProvider,
  type InMemoryRagProviderConfig,
} from './providers/in-memory-rag-provider.js';
export { SimpleRagProviderRegistry } from './providers/simple-provider-registry.js';
export {
  VectorRagProvider,
  type VectorRagProviderConfig,
} from './providers/vector-rag-provider.js';
export { LlmQueryExpander, NoopQueryExpander } from './query-expander.js';
export {
  composeEmbedder,
  type EmbedderResolutionOptions,
  makeRag,
  prefetchRagFactories,
  type RagResolution,
  type RagResolutionOptions,
  ragBackendNames,
  resolveEmbedder,
} from './rag-factories.js';
export { ragStoreKey, SimpleRagRegistry } from './registry/index.js';
export {
  Bm25OnlyStrategy,
  CompositeStrategy,
  type CompositeStrategyEntry,
  type IScoredResult,
  type ISearchCandidate,
  type ISearchContext,
  type ISearchQuery,
  type ISearchStrategy,
  RrfStrategy,
  VectorOnlyStrategy,
  WeightedFusionStrategy,
} from './search-strategy.js';
export { VectorRag, type VectorRagConfig } from './vector-rag.js';
