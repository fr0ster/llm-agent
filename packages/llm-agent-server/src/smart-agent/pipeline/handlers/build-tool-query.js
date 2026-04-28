/**
 * BuildToolQueryHandler — composes an enriched query text for tool/skill retrieval.
 *
 * Reads: `ctx.ragText`, `ctx.ragResults`, `ctx.selectedSkills`
 * Writes: `ctx.toolQueryText`
 *
 * The resulting text combines the user-facing RAG query with top-K snippets
 * already retrieved from non-tool RAG stores plus descriptions of skills
 * selected for this request. Downstream stages configured with
 * `queryText: 'toolQueryText'` use this to drive tool discovery, so consumers
 * can steer tool selection by seeding domain knowledge into other RAG stores
 * or skills.
 *
 * ## Config
 *
 * | Field               | Type    | Default | Description                                          |
 * |---------------------|---------|---------|------------------------------------------------------|
 * | `topK`              | number  | 5       | Max RAG snippets (per store, top-scored) to include |
 * | `maxChars`          | number  | 2000    | Hard cap on the composed text length                 |
 * | `includeRagSnippets`| boolean | true    | Append RAG snippets (excluding `tool:*` IDs)         |
 * | `includeSkills`     | boolean | true    | Append selected skill names + descriptions           |
 * | `skipStores`        | string[]| []      | RAG store names to exclude from snippet source       |
 */
export class BuildToolQueryHandler {
    async execute(ctx, config, span) {
        const topK = config.topK ?? 5;
        const maxChars = config.maxChars ?? 2000;
        const includeRagSnippets = config.includeRagSnippets !== false;
        const includeSkills = config.includeSkills !== false;
        const skipStores = new Set(config.skipStores ?? []);
        const parts = [];
        const base = ctx.ragText || ctx.inputText;
        if (base)
            parts.push(base);
        if (includeRagSnippets) {
            const snippets = [];
            for (const [storeName, results] of Object.entries(ctx.ragResults)) {
                if (skipStores.has(storeName))
                    continue;
                const top = results
                    .filter((r) => {
                    const id = r.metadata?.id;
                    return !id?.startsWith('tool:');
                })
                    .slice(0, topK);
                for (const r of top) {
                    const text = r.text?.trim();
                    if (text)
                        snippets.push(text);
                }
            }
            if (snippets.length > 0) {
                parts.push(`Context:\n${snippets.join('\n')}`);
            }
        }
        if (includeSkills && ctx.selectedSkills.length > 0) {
            const lines = ctx.selectedSkills.map((s) => {
                const desc = s.description?.trim();
                return desc ? `${s.name}: ${desc}` : s.name;
            });
            parts.push(`Active skills:\n${lines.join('\n')}`);
        }
        let composed = parts.join('\n\n');
        if (composed.length > maxChars) {
            composed = `${composed.slice(0, maxChars)}…`;
        }
        ctx.toolQueryText = composed;
        span.setAttribute('length', composed.length);
        span.setAttribute('base_length', base.length);
        span.setAttribute('snippets_included', includeRagSnippets ? 'true' : 'false');
        span.setAttribute('skills_included', includeSkills ? 'true' : 'false');
        ctx.options?.sessionLogger?.logStep('tool_query_built', {
            length: composed.length,
            preview: composed.slice(0, 300),
            skillCount: ctx.selectedSkills.length,
        });
        return true;
    }
}
//# sourceMappingURL=build-tool-query.js.map