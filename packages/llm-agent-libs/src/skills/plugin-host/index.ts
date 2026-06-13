// Skill plugin-host barrel — chunker, marketplace adapter, store, compat wrapper,
// host, RAG source, HTTP marketplace source, and the source-strategy registry.

export { chunkSkill, type SkillIdentity } from './chunker.js';
export {
  type CompatibleSkillsRagDeps,
  makeCompatibleSkillsRag,
} from './compatible-skills-rag.js';
export {
  type HttpMarketplaceSourceOptions,
  type HttpTransportOptions,
  type IMarketplaceTransport,
  makeHttpMarketplaceSource,
  makeHttpTransport,
} from './http-marketplace-source.js';
export {
  type IInMemoryStoreProvider,
  makeInMemoryStoreProvider,
} from './in-memory-store.js';
export {
  buildIngestResult,
  type MarketplaceInput,
} from './marketplace-adapter.js';
export {
  type IngestHostDeps,
  makeSkillPluginHost,
  type RecallHostDeps,
  type SkillPluginHostDeps,
} from './skill-plugin-host.js';
export {
  type SkillsRagSourceConfig,
  skillsRagSource,
} from './skills-rag-source.js';
export {
  type FetchedSourceConfig,
  registerSkillSourceStrategy,
  resolveSkillSourceStrategy,
  type SkillSourceStrategy,
} from './source-strategies.js';
