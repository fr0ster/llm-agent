/**
 * Structured pipeline — public API.
 *
 * Exports the pipeline DSL types, executor, context, condition evaluator,
 * default pipeline definition, and all built-in stage handlers.
 */

// Condition evaluator
export { evaluateCondition } from './condition-evaluator.js';

// Context
export type { PipelineContext } from './context.js';
// Default pipeline
export { DefaultPipeline } from './default-pipeline.js';

// Executor
export { PipelineExecutor } from './executor.js';
// Handler registry
// Individual handlers (for subclassing or direct use)
export {
  AssembleHandler,
  buildDefaultHandlerRegistry,
  ClassifyHandler,
  ExpandHandler,
  RagQueryHandler,
  RerankHandler,
  SkillSelectHandler,
  type StageHandlerRegistry,
  SummarizeHandler,
  ToolLoopHandler,
  ToolSelectHandler,
  TranslateHandler,
} from './handlers/index.js';
// Stage handler interface
export type { IStageHandler } from './stage-handler.js';
// Types
export type {
  BuiltInStageType,
  ControlFlowType,
  StageDefinition,
  StageType,
  StructuredPipelineDefinition,
} from './types.js';
