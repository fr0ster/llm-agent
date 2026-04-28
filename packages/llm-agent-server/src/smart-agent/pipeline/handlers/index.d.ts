/**
 * Default stage handler registry.
 *
 * Maps built-in stage type names to their handler implementations.
 * Custom handlers can be registered by supplying a custom `IPipeline` implementation.
 */
import type { IStageHandler } from '../stage-handler.js';
import { AssembleHandler } from './assemble.js';
import { BuildToolQueryHandler } from './build-tool-query.js';
import { ClassifyHandler } from './classify.js';
import { ExpandHandler } from './expand.js';
import { HistoryUpsertHandler } from './history-upsert.js';
import { RagQueryHandler } from './rag-query.js';
import { RerankHandler } from './rerank.js';
import { SkillSelectHandler } from './skill-select.js';
import { SummarizeHandler } from './summarize.js';
import { ToolLoopHandler } from './tool-loop.js';
import { ToolSelectHandler } from './tool-select.js';
import { TranslateHandler } from './translate.js';
export type StageHandlerRegistry = Map<string, IStageHandler>;
/**
 * Build the default handler registry with all built-in stage handlers.
 *
 * The registry maps stage type names (as used in YAML) to their handler
 * instances. All handlers are stateless — they read/write through the
 * {@link PipelineContext}.
 */
export declare function buildDefaultHandlerRegistry(): StageHandlerRegistry;
export { summarizeAndStore } from './history-upsert.js';
export { AssembleHandler, BuildToolQueryHandler, ClassifyHandler, ExpandHandler, HistoryUpsertHandler, RagQueryHandler, RerankHandler, SkillSelectHandler, SummarizeHandler, ToolLoopHandler, ToolSelectHandler, TranslateHandler, };
//# sourceMappingURL=index.d.ts.map