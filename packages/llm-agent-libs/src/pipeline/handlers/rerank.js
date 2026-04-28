/**
 * RerankHandler — re-scores RAG results using the injected reranker.
 *
 * Reads: `ctx.ragText`, `ctx.ragResults`
 * Writes: `ctx.ragResults` (replaces with re-scored versions)
 *
 * Runs reranking on all stores in parallel. Falls back to original
 * results if reranking fails for a store.
 */
export class RerankHandler {
    async execute(ctx, _config, span) {
        const entries = Object.entries(ctx.ragResults);
        const reranked = await Promise.all(entries.map(async ([name, results]) => {
            if (results.length > 0) {
                const rr = await ctx.reranker.rerank(ctx.ragText, results, ctx.options);
                return { name, results: rr.ok ? rr.value : results };
            }
            return { name, results };
        }));
        for (const { name, results } of reranked) {
            ctx.ragResults[name] = results;
            span.setAttribute(name, results.length);
        }
        return true;
    }
}
//# sourceMappingURL=rerank.js.map