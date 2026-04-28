/**
 * IStageHandler — interface for pipeline stage handlers, specialized to PipelineContext.
 *
 * Re-exports the generic IStageHandler from @mcp-abap-adt/llm-agent with
 * PipelineContext as the context type parameter. This preserves the existing
 * API in llm-agent-libs (all internal handlers use PipelineContext) while
 * removing the separate interface definition and name collision.
 *
 * ## Contract
 *
 * - `execute()` reads inputs from `ctx`, performs its operation, and writes
 *   outputs back to `ctx`.
 * - Returns `true` to continue the pipeline, `false` to abort.
 * - On failure, the handler sets `ctx.error` before returning `false`.
 * - The `config` parameter comes from the stage's `config` field in YAML.
 * - The `span` parameter is a tracing span scoped to this stage execution.
 *
 * ## Custom handlers
 *
 * Consumers can extend the pipeline by supplying a custom `IPipeline`
 * implementation to `SmartAgentBuilder.setPipeline()` and registering
 * additional handlers in their own `buildDefaultHandlerRegistry()` call.
 */

import type { IStageHandler as IStageHandlerBase } from '@mcp-abap-adt/llm-agent';
import type { PipelineContext } from './context.js';

export type IStageHandler = IStageHandlerBase<PipelineContext>;
