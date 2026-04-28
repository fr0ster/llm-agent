/**
 * RagQueryHandler — queries a single RAG store.
 *
 * Reads: `ctx.ragText`, `ctx.ragStores`
 * Writes: `ctx.ragResults[store]` where `store` is from config
 *
 * ## Config
 *
 * | Field   | Type                           | Default  | Description                          |
 * |---------|--------------------------------|----------|--------------------------------------|
 * | `store` | string                         | required | Store key (must exist in `ctx.ragStores`) |
 * | `k`     | number                         | from ctx | Number of results to retrieve        |
 * | `scope` | `global` \| `user` \| `session` | —        | Scope filter: `user` adds userId filter, `session` adds sessionId filter, `global` adds no filter |
 * | `queryText` | `'toolQueryText'` \| string | —       | Overrides the query text for this call. `'toolQueryText'` reads the enriched text from `ctx.toolQueryText` (falls back to `ragText`). Any other string is used literally. When set, a one-off embedding is built for this call without touching the cached `ctx.queryEmbedding`. |
 *
 * ## Parallel safety
 *
 * Each instance writes to a different slot in `ctx.ragResults`, so
 * multiple rag-query stages can safely run in parallel.
 */
import type { ISpan } from '../../tracer/types.js';
import type { PipelineContext } from '../context.js';
import type { IStageHandler } from '../stage-handler.js';
export declare class RagQueryHandler implements IStageHandler {
  execute(
    ctx: PipelineContext,
    config: Record<string, unknown>,
    span: ISpan,
  ): Promise<boolean>;
}
//# sourceMappingURL=rag-query.d.ts.map
