/**
 * RerankHandler — re-scores RAG results using the injected reranker.
 *
 * Reads: `ctx.ragText`, `ctx.ragResults`
 * Writes: `ctx.ragResults` (replaces with re-scored versions)
 *
 * Runs reranking on all stores in parallel. A failed rerank (a returned error
 * or a throw) fails the stage with `RERANK_ERROR` (spec §9.3, D71 — no
 * original-order fallback), recording `<store>.rerank_error` on the span and a
 * `rerank_error` session step.
 *
 * Stores with an explicit retrieval strategy (`hasRetrievalStrategy` on
 * `ctx.ragStores[name]`, `embedding` included) are skipped — the strategy owns
 * their ranking, so an explicit strategy wins over the global reranker.
 */

import { OrchestratorError, type RagResult } from '@mcp-abap-adt/llm-agent';
import { hasRetrievalStrategy } from '../../retrieval/index.js';
import {
  callReranker,
  type RerankFailure,
  rerankFailedError,
} from '../../retrieval/rerank-call.js';
import type { ISpan } from '../../tracer/types.js';
import type { PipelineContext } from '../context.js';
import type { IStageHandler } from '../stage-handler.js';

interface RerankEntry {
  name: string;
  results: RagResult[];
  failure?: RerankFailure;
}

export class RerankHandler implements IStageHandler {
  async execute(
    ctx: PipelineContext,
    _config: Record<string, unknown>,
    span: ISpan,
  ): Promise<boolean> {
    const entries = Object.entries(ctx.ragResults);

    const reranked = await Promise.all(
      entries.map(async ([name, results]): Promise<RerankEntry> => {
        const store = ctx.ragStores?.[name];
        if (store && hasRetrievalStrategy(store)) return { name, results };
        if (results.length > 0) {
          const rr = await callReranker(
            ctx.reranker,
            ctx.ragText,
            results,
            ctx.options,
          );
          if (!rr.ok) {
            span.setAttribute(`${name}.rerank_error`, rr.failure.code);
            ctx.options?.sessionLogger?.logStep('rerank_error', {
              store: name,
              code: rr.failure.code,
              message: rr.failure.message,
            });
            return { name, results, failure: rr.failure };
          }
          return { name, results: rr.value };
        }
        return { name, results };
      }),
    );

    const failed = reranked.find((e) => e.failure !== undefined);
    if (failed?.failure) {
      // Spec §9.3, D71: a failed rerank is the request's error, never the
      // unranked order.
      ctx.error = new OrchestratorError(
        `rerank: store "${failed.name}": ${rerankFailedError(failed.failure).message}`,
        'RERANK_ERROR',
      );
      return false;
    }

    for (const { name, results } of reranked) {
      ctx.ragResults[name] = results;
      span.setAttribute(name, results.length);
    }

    return true;
  }
}
