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
import { QueryEmbedding, TextOnlyEmbedding } from '@mcp-abap-adt/llm-agent';
export class RagQueryHandler {
  async execute(ctx, config, span) {
    const storeName = config.store;
    if (!storeName || !ctx.ragStores[storeName]) {
      span.setAttribute('error', `Invalid store: ${storeName}`);
      return true; // non-fatal, skip
    }
    const k = config.k ?? ctx.config.ragQueryK ?? 10;
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
    let embedding;
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
    // Build scope filter based on config
    const scope = config.scope;
    const scopeFilter = {};
    if (scope === 'user' && ctx.options?.userId) {
      scopeFilter.userId = ctx.options.userId;
    }
    if (scope === 'session') {
      scopeFilter.sessionId = ctx.sessionId;
    }
    const queryOptions = {
      ...ctx.options,
      ragFilter: { ...ctx.options?.ragFilter, ...scopeFilter },
    };
    const ragStart = Date.now();
    const result = await store.query(embedding, k, queryOptions);
    ctx.requestLogger.logRagQuery({
      store: storeName,
      query: queryText.slice(0, 200),
      resultCount: result.ok ? result.value.length : 0,
      durationMs: Date.now() - ragStart,
    });
    // Log embedding usage once (first rag-query stage that uses the embedding)
    if (!ctx.embeddingUsageLogged && embedding?.getUsage) {
      const usage = await embedding.getUsage();
      if (usage) {
        ctx.requestLogger.logLlmCall({
          component: 'embedding',
          model: 'embedder',
          promptTokens: usage.promptTokens,
          completionTokens: 0,
          totalTokens: usage.totalTokens,
          durationMs: 0, // embed completed before store.query(); not separately measurable here
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
        query: queryText.slice(0, 200),
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
//# sourceMappingURL=rag-query.js.map
