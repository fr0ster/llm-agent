import type { ILlm } from '@mcp-abap-adt/llm-agent';
import {
  type CallOptions,
  RagError,
  type RagResult,
  type Result,
} from '@mcp-abap-adt/llm-agent';
import type { IReranker } from './types.js';

const RERANK_SYSTEM_PROMPT = `You are a relevance scoring engine. Given a query and a list of text passages, rate the relevance of each passage to the query on a scale of 0 to 10.

Respond with ONLY a JSON array of numbers representing the scores, one per passage, in the same order.
Example: [8, 3, 10, 1]

Do not include any other text.`;

export class LlmReranker implements IReranker {
  constructor(private readonly llm: ILlm) {}

  async rerank(
    query: string,
    results: RagResult[],
    options?: CallOptions,
  ): Promise<Result<RagResult[], RagError>> {
    if (results.length === 0) {
      return { ok: true, value: results };
    }

    const passages = results.map((r, i) => `[${i}] ${r.text}`).join('\n\n');

    const userPrompt = `Query: ${query}\n\nPassages:\n${passages}`;

    try {
      const res = await this.llm.chat(
        [
          { role: 'system' as const, content: RERANK_SYSTEM_PROMPT },
          { role: 'user' as const, content: userPrompt },
        ],
        [],
        options,
      );

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
    } catch (err) {
      return {
        ok: false,
        error: new RagError(`Reranking failed: ${String(err)}`, 'RERANK_ERROR'),
      };
    }
  }

  private _parseScores(content: string, expectedCount: number): number[] {
    const match = content.match(/\[[\d\s,.-]+\]/);
    if (match) {
      const parsed = JSON.parse(match[0]) as number[];
      if (parsed.length === expectedCount) {
        return parsed.map((s) => Math.max(0, Math.min(10, Number(s) || 0)));
      }
    }
    // Fallback: preserve original ordering
    return Array.from({ length: expectedCount }, (_, i) => expectedCount - i);
  }
}
