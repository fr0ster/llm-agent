/**
 * Default stage handler registry.
 *
 * Maps built-in stage type names to their handler implementations.
 * Custom handlers can be added via `SmartAgentBuilder.withStageHandler()`.
 */

import type { IStageHandler } from '../stage-handler.js';
import { AssembleHandler } from './assemble.js';
import { ClassifyHandler } from './classify.js';
import { ExpandHandler } from './expand.js';
import { RagQueryHandler } from './rag-query.js';
import { RagUpsertHandler } from './rag-upsert.js';
import { RerankHandler } from './rerank.js';
import { SkillSelectHandler } from './skill-select.js';
import { SummarizeHandler } from './summarize.js';
import { PresentHandler } from './present.js';
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
export function buildDefaultHandlerRegistry(): StageHandlerRegistry {
  return new Map<string, IStageHandler>([
    ['classify', new ClassifyHandler()],
    ['summarize', new SummarizeHandler()],
    ['rag-upsert', new RagUpsertHandler()],
    ['translate', new TranslateHandler()],
    ['expand', new ExpandHandler()],
    ['rag-query', new RagQueryHandler()],
    ['rerank', new RerankHandler()],
    ['tool-select', new ToolSelectHandler()],
    ['skill-select', new SkillSelectHandler()],
    ['assemble', new AssembleHandler()],
    ['tool-loop', new ToolLoopHandler()],
    ['present', new PresentHandler()],
  ]);
}

export {
  AssembleHandler,
  ClassifyHandler,
  ExpandHandler,
  PresentHandler,
  RagQueryHandler,
  RagUpsertHandler,
  RerankHandler,
  SkillSelectHandler,
  SummarizeHandler,
  ToolLoopHandler,
  ToolSelectHandler,
  TranslateHandler,
};
