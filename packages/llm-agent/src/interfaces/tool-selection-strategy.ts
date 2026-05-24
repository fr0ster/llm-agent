import type { RagResult } from './types.js';

/**
 * Decides which scored RAG results are relevant enough to drive tool exposure.
 *
 * Input: RAG results gathered for tool discovery (already top-K from the store
 * query, each carrying a cosine `score` in [0,1]). Output: the subset to keep.
 * The pipeline then extracts `tool:`-prefixed ids from the kept results.
 *
 * Pure and side-effect-free so it can be unit-tested in isolation.
 */
export interface IToolSelectionStrategy {
  readonly name: string;
  select(results: RagResult[]): RagResult[];
}
