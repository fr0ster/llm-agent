/**
 * Plugin: score-reranker — reranks RAG results using a custom scoring formula.
 *
 * Demonstrates a custom IReranker that boosts results based on metadata
 * properties (e.g., recency, source priority). Replaces the default reranker.
 *
 * Usage in YAML:
 *   pluginDir: ./plugins
 *   # The reranker is applied globally — all RAG results pass through it.
 *
 * Drop this file into your plugin directory.
 */

import type { IReranker } from '@mcp-abap-adt/llm-agent';
import type { RagResult, CallOptions, RagError, Result } from '@mcp-abap-adt/llm-agent';

/**
 * Boost factors for different metadata ID prefixes.
 * Tools get a significant boost; state/feedback slightly less.
 */
const PREFIX_BOOST: Record<string, number> = {
  'tool:': 0.15,
  'state:': 0.05,
  'feedback:': 0.10,
};

class ScoreBoostReranker implements IReranker {
  async rerank(
    _query: string,
    results: RagResult[],
    _options?: CallOptions,
  ): Promise<Result<RagResult[], RagError>> {
    const boosted = results.map((r) => {
      let boost = 0;
      const id = (r.metadata.id as string) ?? '';

      // Apply prefix-based boost
      for (const [prefix, factor] of Object.entries(PREFIX_BOOST)) {
        if (id.startsWith(prefix)) {
          boost += factor;
          break;
        }
      }

      // Recency boost: if metadata has a timestamp, boost newer results
      if (r.metadata.timestamp) {
        const age = Date.now() - Number(r.metadata.timestamp);
        const hourMs = 3_600_000;
        // Boost up to 0.1 for results less than 1 hour old, decaying linearly
        const recencyBoost = Math.max(0, 0.1 * (1 - age / (24 * hourMs)));
        boost += recencyBoost;
      }

      return {
        ...r,
        score: Math.min(1, r.score + boost),
      };
    });

    // Sort by boosted score, descending
    boosted.sort((a, b) => b.score - a.score);

    return { ok: true, value: boosted };
  }
}

// Plugin export
export const reranker = new ScoreBoostReranker();
