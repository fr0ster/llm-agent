/**
 * ExpandHandler — expands RAG query with synonyms and related terms.
 *
 * Reads: `ctx.ragText`, `ctx.queryExpander`
 * Writes: `ctx.ragText`
 *
 * Uses the injected IQueryExpander to broaden RAG queries.
 * Skipped when `queryExpansionEnabled` is false.
 */
export class ExpandHandler {
  async execute(ctx, _config, span) {
    if (!ctx.config.queryExpansionEnabled) {
      span.setAttribute('skipped', true);
      return true;
    }
    const result = await ctx.queryExpander.expand(ctx.ragText, ctx.options);
    if (result.ok) {
      ctx.ragText = result.value;
      span.setAttribute('expanded', true);
    }
    return true;
  }
}
//# sourceMappingURL=expand.js.map
