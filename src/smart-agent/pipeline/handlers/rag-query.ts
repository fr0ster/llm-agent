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
 *
 * ## Parallel safety
 *
 * Each instance writes to a different slot in `ctx.ragResults`, so
 * multiple rag-query stages can safely run in parallel.
 */

import type { RagScope } from '../../interfaces/plugin.js';
import type { CallOptions } from '../../interfaces/types.js';
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

    // Build scope filter based on config
    const scope = config.scope as RagScope | undefined;
    const scopeFilter: Record<string, unknown> = {};
    if (scope === 'user' && ctx.options?.userId) {
      scopeFilter.userId = ctx.options.userId;
    }
    if (scope === 'session') {
      scopeFilter.sessionId = ctx.sessionId;
    }

    const queryOptions: CallOptions = {
      ...ctx.options,
      ragFilter: { ...ctx.options?.ragFilter, ...scopeFilter },
    };

    const ragStart = Date.now();
    const result = await store.query(ctx.queryEmbedding, k, queryOptions);
    ctx.requestLogger.logRagQuery({
      store: storeName,
      query: ctx.ragText.slice(0, 200),
      resultCount: result.ok ? result.value.length : 0,
      durationMs: Date.now() - ragStart,
    });

    // Log embedding usage once (first rag-query stage that uses the embedding)
    if (!ctx.embeddingUsageLogged && ctx.queryEmbedding?.getUsage) {
      const usage = await ctx.queryEmbedding.getUsage();
      if (usage) {
        ctx.requestLogger.logLlmCall({
          component: 'embedding',
          model: ctx.embedder?.constructor?.name ?? 'embedder',
          promptTokens: usage.promptTokens,
          completionTokens: 0,
          totalTokens: usage.totalTokens,
          durationMs: Date.now() - ragStart,
          scope: 'request',
        });
        ctx.embeddingUsageLogged = true;
      }
    }

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
