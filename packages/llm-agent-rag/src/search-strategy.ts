import type { RagMetadata } from '@mcp-abap-adt/llm-agent';
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
  /**
   * Term statistics over THIS query's candidates only — the records that
   * passed the store's namespace / TTL / session / user filters — never over
   * the whole store: store-wide statistics make one session's ranking depend
   * on (and leak a signal about) another session's records. The built-in
   * strategies do not read it; they compute the same statistics from the
   * `candidates` they are given, so they are scoped whatever a caller passes.
   * Kept for custom strategies.
   */
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

/**
 * BM25 term statistics over a candidate set: document frequency, document
 * count and average length come from `candidates` alone, so a query's scores
 * depend only on the records it may see.
 */
interface KeywordStats {
  docTokens: string[][];
  df: Map<string, number>;
  n: number;
  avgDocLength: number;
}

function keywordStats(
  candidates: ISearchCandidate[],
  tokenize: (s: string) => string[],
): KeywordStats {
  const docTokens = candidates.map((c) => tokenize(c.text));
  const df = new Map<string, number>();
  let total = 0;
  for (const tokens of docTokens) {
    total += tokens.length;
    for (const t of new Set(tokens)) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const n = docTokens.length;
  return { docTokens, df, n, avgDocLength: n === 0 ? 0 : total / n };
}

function bm25(
  queryTokens: string[],
  docIdx: number,
  stats: KeywordStats,
): number {
  const docTokens = stats.docTokens[docIdx];
  if (queryTokens.length === 0 || docTokens.length === 0) return 0;
  const avgDocLength = stats.avgDocLength || 1;
  const n = stats.n || 1;
  const k1 = 1.2;
  const b = 0.75;
  let score = 0;
  for (const token of new Set(queryTokens)) {
    const df = stats.df.get(token) ?? 0;
    const idf = Math.log((n - df + 0.5) / (df + 0.5) + 1);
    const tf = docTokens.filter((t) => t === token).length;
    const tfScored =
      (tf * (k1 + 1)) /
      (tf + k1 * (1 - b + b * (docTokens.length / avgDocLength)));
    score += idf * tfScored;
  }
  return score;
}

/** Raw BM25 of every candidate, in candidate order. */
function bm25Scores(
  query: ISearchQuery,
  candidates: ISearchCandidate[],
  context: ISearchContext,
): number[] {
  const queryTokens = context.tokenize(query.text);
  const stats = keywordStats(candidates, context.tokenize);
  return candidates.map((_c, i) => bm25(queryTokens, i, stats));
}

/**
 * Raw BM25 is unbounded; the historical absolute scale, kept for the score
 * `Bm25OnlyStrategy` reports (ranking uses the raw value, so the clamp no
 * longer flattens strong matches into a tie).
 */
function bm25Absolute(raw: number): number {
  return Math.min(raw / 5, 1.0);
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
    // BM25 normalised per query over these candidates (divided by the best
    // one), so both parts are in [0, 1] and the weights mean what they say:
    // the best keyword match contributes exactly `keywordWeight`.
    const raw = bm25Scores(query, candidates, context);
    const max = Math.max(0, ...raw);
    return candidates
      .map((c, i) => ({
        text: c.text,
        metadata: c.metadata,
        score:
          cosine(query.vector, c.vector) * this.vectorWeight +
          (max > 0 ? raw[i] / max : 0) * this.keywordWeight,
      }))
      .sort((a, b) => b.score - a.score);
  }
}

// ---------------------------------------------------------------------------
// RrfStrategy
// ---------------------------------------------------------------------------

/**
 * Reciprocal Rank Fusion: combines vector and BM25 rankings using
 * `score(doc) = 1/(k + rank_vector) + 1/(k + rank_bm25)`.
 *
 * RRF is rank-based — it doesn't depend on raw score magnitudes,
 * which makes it more stable than weighted sum when vector and BM25
 * score distributions differ.
 */
export class RrfStrategy implements ISearchStrategy {
  readonly name = 'rrf';
  private readonly k: number;

  constructor(config?: { k?: number }) {
    this.k = config?.k ?? 60;
  }

  score(
    query: ISearchQuery,
    candidates: ISearchCandidate[],
    context: ISearchContext,
  ): IScoredResult[] {
    // Score by each method independently
    const vectorScores = candidates.map((c, i) => ({
      idx: i,
      score: cosine(query.vector, c.vector),
    }));
    const bm25Ranked = bm25Scores(query, candidates, context).map(
      (score, idx) => ({ idx, score }),
    );

    // Sort each list desc to get ranks
    vectorScores.sort((a, b) => b.score - a.score);
    bm25Ranked.sort((a, b) => b.score - a.score);

    // Build rank maps (0-indexed rank)
    const vectorRank = new Map<number, number>();
    const bm25Rank = new Map<number, number>();
    for (let i = 0; i < vectorScores.length; i++)
      vectorRank.set(vectorScores[i].idx, i);
    for (let i = 0; i < bm25Ranked.length; i++)
      bm25Rank.set(bm25Ranked[i].idx, i);

    // Compute RRF score
    return candidates
      .map((c, i) => ({
        text: c.text,
        metadata: c.metadata,
        score:
          1 / (this.k + (vectorRank.get(i) ?? candidates.length)) +
          1 / (this.k + (bm25Rank.get(i) ?? candidates.length)),
      }))
      .sort((a, b) => b.score - a.score);
  }
}

// ---------------------------------------------------------------------------
// VectorOnlyStrategy
// ---------------------------------------------------------------------------

/**
 * Pure vector cosine similarity. No keyword component.
 * Useful as a baseline or when BM25 tokenization doesn't match the domain.
 */
export class VectorOnlyStrategy implements ISearchStrategy {
  readonly name = 'vector-only';

  score(
    query: ISearchQuery,
    candidates: ISearchCandidate[],
    _context: ISearchContext,
  ): IScoredResult[] {
    return candidates
      .map((c) => ({
        text: c.text,
        metadata: c.metadata,
        score: cosine(query.vector, c.vector),
      }))
      .sort((a, b) => b.score - a.score);
  }
}

// ---------------------------------------------------------------------------
// Bm25OnlyStrategy
// ---------------------------------------------------------------------------

/**
 * Pure BM25 lexical scoring. No vector component.
 * Useful when embedder is unavailable or for exact-match-heavy domains.
 */
export class Bm25OnlyStrategy implements ISearchStrategy {
  readonly name = 'bm25-only';

  score(
    query: ISearchQuery,
    candidates: ISearchCandidate[],
    context: ISearchContext,
  ): IScoredResult[] {
    const raw = bm25Scores(query, candidates, context);
    return candidates
      .map((c, i) => ({ c, raw: raw[i] }))
      .sort((a, b) => b.raw - a.raw)
      .map(({ c, raw: r }) => ({
        text: c.text,
        metadata: c.metadata,
        score: bm25Absolute(r),
      }));
  }
}

// ---------------------------------------------------------------------------
// CompositeStrategy
// ---------------------------------------------------------------------------

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
export class CompositeStrategy implements ISearchStrategy {
  readonly name: string;
  private readonly entries: CompositeStrategyEntry[];
  private readonly k: number;

  constructor(entries: CompositeStrategyEntry[], config?: { k?: number }) {
    this.entries = entries;
    this.k = config?.k ?? 60;
    this.name = `composite(${entries.map((e) => e.strategy.name).join('+')})`;
  }

  score(
    query: ISearchQuery,
    candidates: ISearchCandidate[],
    context: ISearchContext,
  ): IScoredResult[] {
    if (candidates.length === 0) return [];

    // Run all strategies on the same candidates
    const rankedLists = this.entries.map((entry) => {
      const scored = entry.strategy.score(query, candidates, context);
      // Build rank map: metadata.id → rank (0-indexed)
      const rankMap = new Map<string, number>();
      for (let i = 0; i < scored.length; i++) {
        const id = scored[i].metadata.id as string;
        // For dual-index: same tool may appear multiple times.
        // Keep best rank (first occurrence = highest score).
        if (!rankMap.has(id)) rankMap.set(id, i);
      }
      return { rankMap, weight: entry.weight };
    });

    // Compute weighted RRF per candidate
    const scoreMap = new Map<
      string,
      { text: string; metadata: RagMetadata; score: number }
    >();

    for (const c of candidates) {
      const id = c.metadata.id as string;
      if (scoreMap.has(id)) continue; // dedup by id — take first occurrence

      let totalScore = 0;
      for (const { rankMap, weight } of rankedLists) {
        const rank = rankMap.get(id) ?? candidates.length;
        totalScore += weight / (this.k + rank);
      }

      scoreMap.set(id, {
        text: c.text,
        metadata: c.metadata,
        score: totalScore,
      });
    }

    return [...scoreMap.values()].sort((a, b) => b.score - a.score);
  }
}
