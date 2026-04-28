import { RagError, } from '@mcp-abap-adt/llm-agent';
const RERANK_SYSTEM_PROMPT = `You are a relevance scoring engine. Given a query and a list of text passages, rate the relevance of each passage to the query on a scale of 0 to 10.

Respond with ONLY a JSON array of numbers representing the scores, one per passage, in the same order.
Example: [8, 3, 10, 1]

Do not include any other text.`;
export class LlmReranker {
    llm;
    constructor(llm) {
        this.llm = llm;
    }
    async rerank(query, results, options) {
        if (results.length === 0) {
            return { ok: true, value: results };
        }
        const passages = results.map((r, i) => `[${i}] ${r.text}`).join('\n\n');
        const userPrompt = `Query: ${query}\n\nPassages:\n${passages}`;
        try {
            const res = await this.llm.chat([
                { role: 'system', content: RERANK_SYSTEM_PROMPT },
                { role: 'user', content: userPrompt },
            ], [], options);
            if (!res.ok) {
                return {
                    ok: false,
                    error: new RagError(res.error.message, 'RERANK_ERROR'),
                };
            }
            const scores = this._parseScores(res.value.content, results.length);
            const reranked = results
                .map((r, i) => ({ ...r, score: scores[i] / 10 }))
                .sort((a, b) => b.score - a.score);
            return { ok: true, value: reranked };
        }
        catch (err) {
            return {
                ok: false,
                error: new RagError(`Reranking failed: ${String(err)}`, 'RERANK_ERROR'),
            };
        }
    }
    _parseScores(content, expectedCount) {
        const match = content.match(/\[[\d\s,.-]+\]/);
        if (match) {
            const parsed = JSON.parse(match[0]);
            if (parsed.length === expectedCount) {
                return parsed.map((s) => Math.max(0, Math.min(10, Number(s) || 0)));
            }
        }
        // Fallback: preserve original ordering
        return Array.from({ length: expectedCount }, (_, i) => expectedCount - i);
    }
}
//# sourceMappingURL=llm-reranker.js.map