/**
 * PipelineContext — mutable state bag threaded through all pipeline stages.
 *
 * Each stage reads its inputs from the context and writes its outputs back.
 * The context is created fresh per request and is never shared across requests.
 *
 * ## Data ownership
 *
 * Stages must write to non-overlapping fields. For parallel execution, this
 * means each `rag-query` handler writes to its own store slot
 * in `ragResults`, avoiding data races.
 *
 * ## Streaming
 *
 * The `tool-loop` stage streams. It uses `ctx.yield()` to push
 * SSE chunks back to the caller. All other stages are batch operations.
 */
export {};
//# sourceMappingURL=context.js.map
