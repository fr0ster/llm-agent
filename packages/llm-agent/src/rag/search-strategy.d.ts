import type { RagMetadata } from '../interfaces/types.js';
import type { InvertedIndex } from './inverted-index.js';
export interface ISearchCandidate {
    text: string;
    vector: number[];
    metadata: RagMetadata;
}
export interface ISearchQuery {
    text: string;
    vector: number[];
}
export interface IScoredResult {
    text: string;
    metadata: RagMetadata;
    score: number;
}
export interface ISearchContext {
    index: InvertedIndex;
    tokenize: (s: string) => string[];
}
export interface ISearchStrategy {
    readonly name: string;
    score(query: ISearchQuery, candidates: ISearchCandidate[], context: ISearchContext): IScoredResult[];
}
export declare class WeightedFusionStrategy implements ISearchStrategy {
    readonly name = "weighted-fusion";
    private readonly vectorWeight;
    private readonly keywordWeight;
    constructor(config?: {
        vectorWeight?: number;
        keywordWeight?: number;
    });
    score(query: ISearchQuery, candidates: ISearchCandidate[], context: ISearchContext): IScoredResult[];
}
/**
 * Reciprocal Rank Fusion: combines vector and BM25 rankings using
 * `score(doc) = 1/(k + rank_vector) + 1/(k + rank_bm25)`.
 *
 * RRF is rank-based — it doesn't depend on raw score magnitudes,
 * which makes it more stable than weighted sum when vector and BM25
 * score distributions differ.
 */
export declare class RrfStrategy implements ISearchStrategy {
    readonly name = "rrf";
    private readonly k;
    constructor(config?: {
        k?: number;
    });
    score(query: ISearchQuery, candidates: ISearchCandidate[], context: ISearchContext): IScoredResult[];
}
/**
 * Pure vector cosine similarity. No keyword component.
 * Useful as a baseline or when BM25 tokenization doesn't match the domain.
 */
export declare class VectorOnlyStrategy implements ISearchStrategy {
    readonly name = "vector-only";
    score(query: ISearchQuery, candidates: ISearchCandidate[], _context: ISearchContext): IScoredResult[];
}
/**
 * Pure BM25 lexical scoring. No vector component.
 * Useful when embedder is unavailable or for exact-match-heavy domains.
 */
export declare class Bm25OnlyStrategy implements ISearchStrategy {
    readonly name = "bm25-only";
    score(query: ISearchQuery, candidates: ISearchCandidate[], context: ISearchContext): IScoredResult[];
}
export interface CompositeStrategyEntry {
    strategy: ISearchStrategy;
    weight: number;
}
/**
 * Combines multiple strategies via weighted Reciprocal Rank Fusion.
 *
 * Each child strategy scores all candidates independently.
 * Results are merged using: `score(doc) = Σ weight_i / (k + rank_i)`
 *
 * All child strategies run synchronously on the same candidates —
 * no I/O, pure CPU, single event-loop tick.
 */
export declare class CompositeStrategy implements ISearchStrategy {
    readonly name: string;
    private readonly entries;
    private readonly k;
    constructor(entries: CompositeStrategyEntry[], config?: {
        k?: number;
    });
    score(query: ISearchQuery, candidates: ISearchCandidate[], context: ISearchContext): IScoredResult[];
}
//# sourceMappingURL=search-strategy.d.ts.map