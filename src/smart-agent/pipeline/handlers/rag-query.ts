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
 * | `store` | string | required | Store key (must exist in `ctx.ragStores`) |
 * | `k`     | number | from ctx | Number of results to retrieve        |
 *
 * ## Parallel safety
 *
 * Each instance writes to a different slot in `ctx.ragResults`, so
 * multiple rag-query stages can safely run in parallel.
 */

import {
  QueryEmbedding,
  TextOnlyEmbedding,
} from '../../rag/query-embedding.js';
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
    if (!storeName || !ctx.ragStores[storeName]) {
      span.setAttribute('error', `Invalid store: ${storeName}`);
      return true; // non-fatal, skip
    }

    const k = (config.k as number) ?? ctx.config.ragQueryK ?? 10;
    const store = ctx.ragStores[storeName];

    span.setAttribute('store', storeName);
    span.setAttribute('k', k);

    // Lazily create and cache a shared query embedding for all rag-query stages
    if (!ctx.queryEmbedding) {
      ctx.queryEmbedding = ctx.embedder
        ? new QueryEmbedding(ctx.ragText, ctx.embedder, ctx.options)
        : new TextOnlyEmbedding(ctx.ragText);
    }

    const ragStart = Date.now();
    const result = await store.query(ctx.queryEmbedding, k, ctx.options);
    ctx.requestLogger.logRagQuery({
      store: storeName,
      query: ctx.ragText.slice(0, 200),
      resultCount: result.ok ? result.value.length : 0,
      durationMs: Date.now() - ragStart,
    });

    ctx.metrics.ragQueryCount.add(1, {
      store: storeName,
      hit: String(result.ok && result.value.length > 0),
    });

    if (result.ok) {
      ctx.ragResults[storeName] = result.value;
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
