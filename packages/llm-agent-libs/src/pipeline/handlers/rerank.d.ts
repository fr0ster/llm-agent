/**
 * RerankHandler — re-scores RAG results using the injected reranker.
 *
 * Reads: `ctx.ragText`, `ctx.ragResults`
 * Writes: `ctx.ragResults` (replaces with re-scored versions)
 *
 * Runs reranking on all stores in parallel. Falls back to original
 * results if reranking fails for a store.
 */
import type { ISpan } from '../../tracer/types.js';
import type { PipelineContext } from '../context.js';
import type { IStageHandler } from '../stage-handler.js';
export declare class RerankHandler implements IStageHandler {
  execute(
    ctx: PipelineContext,
    _config: Record<string, unknown>,
    span: ISpan,
  ): Promise<boolean>;
}
//# sourceMappingURL=rerank.d.ts.map
