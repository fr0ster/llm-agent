/**
 * RerankHandler — re-scores RAG results using the injected reranker.
 *
 * Reads: `ctx.ragText`, `ctx.ragResults`
 * Writes: `ctx.ragResults` (replaces with re-scored versions)
 *
 * Runs reranking on all three stores in parallel. Falls back to original
 * results if reranking fails for a store.
 */

import type { ISpan } from '../../tracer/types.js';
import type { PipelineContext } from '../context.js';
import type { IStageHandler } from '../stage-handler.js';

export class RerankHandler implements IStageHandler {
  async execute(
    ctx: PipelineContext,
    _config: Record<string, unknown>,
    span: ISpan,
  ): Promise<boolean> {
    const [rerankedFacts, rerankedFeedback, rerankedState] = await Promise.all([
      ctx.ragResults.facts.length > 0
        ? ctx.reranker.rerank(ctx.ragText, ctx.ragResults.facts, ctx.options)
        : Promise.resolve({ ok: true as const, value: ctx.ragResults.facts }),
      ctx.ragResults.feedback.length > 0
        ? ctx.reranker.rerank(ctx.ragText, ctx.ragResults.feedback, ctx.options)
        : Promise.resolve({
            ok: true as const,
            value: ctx.ragResults.feedback,
          }),
      ctx.ragResults.state.length > 0
        ? ctx.reranker.rerank(ctx.ragText, ctx.ragResults.state, ctx.options)
        : Promise.resolve({ ok: true as const, value: ctx.ragResults.state }),
    ]);

    if (rerankedFacts.ok) ctx.ragResults.facts = rerankedFacts.value;
    if (rerankedFeedback.ok) ctx.ragResults.feedback = rerankedFeedback.value;
    if (rerankedState.ok) ctx.ragResults.state = rerankedState.value;

    span.setAttribute('facts', ctx.ragResults.facts.length);
    span.setAttribute('feedback', ctx.ragResults.feedback.length);
    span.setAttribute('state', ctx.ragResults.state.length);
    return true;
  }
}
