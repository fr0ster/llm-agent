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
 * Consumers can extend the pipeline by supplying a custom `IPipeline`
 * implementation to `SmartAgentBuilder.setPipeline()` and registering
 * additional handlers in their own `buildDefaultHandlerRegistry()` call.
 */
export {};
//# sourceMappingURL=stage-handler.js.map