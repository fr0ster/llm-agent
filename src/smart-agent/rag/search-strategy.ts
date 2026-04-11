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
  score(
    query: ISearchQuery,
    candidates: ISearchCandidate[],
    context: ISearchContext,
  ): IScoredResult[];
}

// ---------------------------------------------------------------------------
// Module-private helpers (reused by all strategies in this file)
// ---------------------------------------------------------------------------

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] ** 2;
    nb += b[i] ** 2;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

function bm25(
  queryTokens: string[],
  docText: string,
  context: ISearchContext,
): number {
  const docTokens = context.tokenize(docText);
  if (queryTokens.length === 0 || docTokens.length === 0) return 0;
  const avgDocLength = context.index.avgDocLength || 1;
  const n = context.index.docCount || 1;
  const k1 = 1.2;
  const b = 0.75;
  let score = 0;
  for (const token of new Set(queryTokens)) {
    const df = context.index.getDocFrequency(token);
    const idf = Math.log((n - df + 0.5) / (df + 0.5) + 1);
    const tf = docTokens.filter((t) => t === token).length;
    const tfScored =
      (tf * (k1 + 1)) /
      (tf + k1 * (1 - b + b * (docTokens.length / avgDocLength)));
    score += idf * tfScored;
  }
  return Math.min(score / 5, 1.0);
}

// ---------------------------------------------------------------------------
// WeightedFusionStrategy
// ---------------------------------------------------------------------------

export class WeightedFusionStrategy implements ISearchStrategy {
  readonly name = 'weighted-fusion';
  private readonly vectorWeight: number;
  private readonly keywordWeight: number;

  constructor(config?: { vectorWeight?: number; keywordWeight?: number }) {
    this.vectorWeight = config?.vectorWeight ?? 0.7;
    this.keywordWeight = config?.keywordWeight ?? 0.3;
  }

  score(
    query: ISearchQuery,
    candidates: ISearchCandidate[],
    context: ISearchContext,
  ): IScoredResult[] {
    const queryTokens = context.tokenize(query.text);
    return candidates
      .map((c) => ({
        text: c.text,
        metadata: c.metadata,
        score:
          cosine(query.vector, c.vector) * this.vectorWeight +
          bm25(queryTokens, c.text, context) * this.keywordWeight,
      }))
      .sort((a, b) => b.score - a.score);
  }
}
