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
import type { CallOptions, IReranker, RagError, RagResult, Result } from '@mcp-abap-adt/llm-agent';
declare class ScoreBoostReranker implements IReranker {
    rerank(_query: string, results: RagResult[], _options?: CallOptions): Promise<Result<RagResult[], RagError>>;
}
export declare const reranker: ScoreBoostReranker;
export {};
//# sourceMappingURL=03-score-reranker.d.ts.map