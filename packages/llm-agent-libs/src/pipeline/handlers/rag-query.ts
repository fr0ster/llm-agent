import { denyRagAccess, ownerBoundQuery } from '../../rag/owner-bound-query.js';
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
 * Ownership and identity filters come exclusively from the registered store.
 * Legacy `scope` stage configuration cannot widen its ownership.
 * | `queryText` | `'toolQueryText'` \| string | —       | Overrides the query text for this call. `'toolQueryText'` reads the enriched text from `ctx.toolQueryText` (falls back to `ragText`). Any other string is used literally. When set, a one-off embedding is built for this call without touching the cached `ctx.queryEmbedding`. |
 *
 * ## Parallel safety
 *
 * Each instance writes to a different slot in `ctx.ragResults`, so
 * multiple rag-query stages can safely run in parallel.
 */

import type { CallOptions } from '@mcp-abap-adt/llm-agent';
import { QueryEmbedding, TextOnlyEmbedding } from '@mcp-abap-adt/llm-agent';
import { withRelevanceQuery } from '../../retrieval/relevance-query.js';
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

    // Resolve the query text for this call. Optional `queryText` override
    // bypasses the shared cache so enriched-context searches don't pollute
    // subsequent ragText-based queries.
    const queryTextOverride =
      typeof config.queryText === 'string'
        ? config.queryText === 'toolQueryText'
          ? (ctx.toolQueryText ?? ctx.ragText)
          : config.queryText
        : undefined;
    const queryText = queryTextOverride ?? ctx.ragText;

    let embedding: typeof ctx.queryEmbedding;
    if (queryTextOverride !== undefined) {
      embedding = ctx.embedder
        ? new QueryEmbedding(queryText, ctx.embedder, ctx.options)
        : new TextOnlyEmbedding(queryText);
      span.setAttribute('query_text_override', true);
    } else {
      // Lazily create and cache a shared query embedding for all rag-query stages
      if (!ctx.queryEmbedding) {
        ctx.queryEmbedding = ctx.embedder
          ? new QueryEmbedding(ctx.ragText, ctx.embedder, ctx.options)
          : new TextOnlyEmbedding(ctx.ragText);
      }
      embedding = ctx.queryEmbedding;
    }

    const queryOptions: CallOptions =
      ctx.preExpansionRagText === undefined
        ? { ...ctx.options }
        : withRelevanceQuery({ ...ctx.options }, ctx.preExpansionRagText);

    const ragStart = Date.now();
    const result = await ownerBoundQuery(
      store,
      embedding,
      k,
      queryOptions,
      ctx.ragAccess ?? denyRagAccess,
    );
    ctx.requestLogger.logRagQuery({
      store: storeName,
      query: queryText.slice(0, 200),
      resultCount: result.ok ? result.value.length : 0,
      durationMs: Date.now() - ragStart,
      requestId: ctx.options?.trace?.traceId,
    });

    // Embedding usage is logged at the embedder boundary (UsageLoggingEmbedder),
    // not here — `QueryEmbedding` memoizes one embed() per instance, so the
    // wrapper logs it exactly once with the request's traceId.

    ctx.metrics.ragQueryCount.add(1, {
      store: storeName,
      hit: String(result.ok && result.value.length > 0),
    });

    if (!result.ok) {
      ctx.error = result.error;
      return false;
    }
    if (result.ok) {
      ctx.ragResults[storeName] = result.value;
      span.setAttribute('results', result.value.length);

      // Log RAG results with scores for diagnostics
      ctx.options?.sessionLogger?.logStep(
        `rag_query_${storeName}`,
        {
          query: queryText.slice(0, 200),
          k,
          resultCount: result.value.length,
          results: result.value.map((r) => ({
            id: r.metadata.id,
            score: r.score,
            text: r.text.slice(0, 120),
          })),
        },
        'rag',
      );
    }

    return true;
  }
}
