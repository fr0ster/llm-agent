/**
 * IStageHandler — interface for pipeline stage handlers.
 *
 * Each built-in stage type (classify, summarize, rag-query, etc.) has a
 * corresponding handler implementation. Handlers are stateless — all mutable
 * state lives in the {@link PipelineContext}.
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
 * Consumers can register custom stage handlers via
 * `SmartAgentBuilder.withStageHandler(type, handler)` to extend the pipeline
 * with domain-specific operations.
 */

import type { ISpan } from '../tracer/types.js';
import type { PipelineContext } from './context.js';

export interface IStageHandler {
  /**
   * Execute the stage.
   *
   * @param ctx    - Mutable pipeline context (read inputs, write outputs).
   * @param config - Stage-specific config from the YAML `config` field.
   * @param span   - Tracing span for this stage (call `span.end()` is handled by executor).
   * @returns `true` to continue pipeline, `false` to abort.
   */
  execute(
    ctx: PipelineContext,
    config: Record<string, unknown>,
    span: ISpan,
  ): Promise<boolean>;
}
