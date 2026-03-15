/**
 * RagQueryHandler — queries a single RAG store.
 *
 * Reads: `ctx.ragText`, `ctx.ragStores`
 * Writes: `ctx.ragResults[store]` where `store` is from config
 *
 * ## Config
 *
 * | Field   | Type   | Default  | Description                          |
 * |---------|--------|----------|--------------------------------------|
 * | `store` | string | required | Which store: `'facts'`, `'feedback'`, `'state'` |
 * | `k`     | number | from ctx | Number of results to retrieve        |
 *
 * ## Parallel safety
 *
 * Each instance writes to a different slot in `ctx.ragResults`, so
 * multiple rag-query stages can safely run in parallel.
 */

import type { ISpan } from '../../tracer/types.js';
import type { PipelineContext } from '../context.js';
import type { IStageHandler } from '../stage-handler.js';

export class RagQueryHandler implements IStageHandler {
  async execute(
    ctx: PipelineContext,
    config: Record<string, unknown>,
    span: ISpan,
  ): Promise<boolean> {
    const storeName = config.store as string;
    if (!storeName || !['facts', 'feedback', 'state'].includes(storeName)) {
      span.setAttribute('error', `Invalid store: ${storeName}`);
      return true; // non-fatal, skip
    }

    const k = (config.k as number) ?? ctx.config.ragQueryK ?? 10;
    const store = ctx.ragStores[storeName as keyof typeof ctx.ragStores];

    span.setAttribute('store', storeName);
    span.setAttribute('k', k);

    const result = await store.query(ctx.ragText, k, ctx.options);

    ctx.metrics.ragQueryCount.add(1, {
      store: storeName,
      hit: String(result.ok && result.value.length > 0),
    });

    if (result.ok) {
      ctx.ragResults[storeName as keyof typeof ctx.ragResults] = result.value;
      span.setAttribute('results', result.value.length);

      // Log RAG results with scores for diagnostics
      ctx.options?.sessionLogger?.logStep(`rag_query_${storeName}`, {
        query: ctx.ragText.slice(0, 200),
        k,
        resultCount: result.value.length,
        results: result.value.map((r) => ({
          id: r.metadata.id,
          score: r.score,
          text: r.text.slice(0, 120),
        })),
      });
    }

    return true;
  }
}
