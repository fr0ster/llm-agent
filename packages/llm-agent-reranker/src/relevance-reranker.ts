// packages/llm-agent-reranker/src/relevance-reranker.ts
import {
  type CallOptions,
  type IRelevanceDecision,
  type IReranker,
  RagError,
  type RagResult,
  type RelevanceScore,
  type Result,
} from '@mcp-abap-adt/llm-agent';
import { assertPositiveInteger } from './assert-positive-integer.js';
import {
  batchByTokens,
  DEFAULT_CONCURRENCY,
  DEFAULT_MAX_BATCH_TOKENS,
  estimateTokens,
  runInWaves,
  sortByScore,
} from './batching.js';

export interface RelevanceRerankerOptions {
  /**
   * Estimated-token budget per `score()` call (~4 chars/token, query + passages);
   * a positive integer. Default 48000 (as `ProbabilityReranker`). The scores of
   * all batches are merged into one order: relevance scores are comparable for
   * the same query and model, also across calls (`IRelevanceDecision`, spec §3.9).
   */
  maxBatchTokens?: number;
  /** Max `score()` calls in flight; a positive integer. Default 4 (as `ProbabilityReranker`). */
  concurrency?: number;
}

/** One entry per passage of the call, each index once, every score finite (spec §5.2). */
function checkScores(
  scores: readonly RelevanceScore[],
  n: number,
): string | undefined {
  if (scores.length !== n) return `${scores.length} scores for ${n} passages`;
  const seen = new Set<number>();
  for (const s of scores) {
    if (!Number.isInteger(s.index) || s.index < 0 || s.index >= n)
      return `out-of-range index ${s.index}`;
    if (seen.has(s.index)) return `index ${s.index} twice`;
    if (typeof s.score !== 'number' || !Number.isFinite(s.score))
      return `non-finite score for index ${s.index}`;
    seen.add(s.index);
  }
  return undefined;
}

/**
 * Rerank RAG results with a relevance decision (a cross-encoder). `score`
 * becomes the RELEVANCE SCORE — NOT a probability. Scores for the same query
 * from the same model are comparable across calls, so candidates are batched
 * under `maxBatchTokens` (up to `concurrency` calls in flight) and the batches
 * are merged into one order. A threshold on the score is the consumer's
 * calibration (no default uses one). Any failed call or bad answer fails the
 * whole rerank with RERANK_ERROR.
 */
export class RelevanceReranker implements IReranker {
  private readonly maxBatchTokens: number;
  private readonly concurrency: number;

  /** @throws Error when `maxBatchTokens` or `concurrency` is not a positive integer. */
  constructor(
    private readonly decision: IRelevanceDecision,
    options: RelevanceRerankerOptions = {},
  ) {
    this.maxBatchTokens = options.maxBatchTokens ?? DEFAULT_MAX_BATCH_TOKENS;
    this.concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
    assertPositiveInteger(
      'RelevanceReranker',
      'maxBatchTokens',
      this.maxBatchTokens,
    );
    assertPositiveInteger('RelevanceReranker', 'concurrency', this.concurrency);
  }

  async rerank(
    query: string,
    results: RagResult[],
    options?: CallOptions,
  ): Promise<Result<RagResult[], RagError>> {
    if (results.length === 0) return { ok: true, value: results };
    const batches = batchByTokens(
      estimateTokens(query),
      results.map((r) => estimateTokens(r.text)),
      this.maxBatchTokens,
    );
    const waves = await runInWaves(batches, this.concurrency, (idxs) =>
      this.scoreBatch(query, results, idxs, options),
    );
    if (!waves.ok) return waves;
    const score = new Array<number>(results.length);
    for (const { idxs, value } of waves.value) {
      for (const s of value) score[idxs[s.index]] = s.score;
    }
    return { ok: true, value: sortByScore(results, score) };
  }

  /** One `score()` call, its answer checked (spec §5.2 items 3–4). */
  private async scoreBatch(
    query: string,
    results: RagResult[],
    idxs: number[],
    options?: CallOptions,
  ): Promise<Result<readonly RelevanceScore[], RagError>> {
    let res: Awaited<ReturnType<IRelevanceDecision['score']>>;
    try {
      res = await this.decision.score(
        { query, passages: idxs.map((i) => results[i].text) },
        options,
      );
    } catch (e) {
      // A throw / rejection is a failed call too: a Result error, never an exception.
      return {
        ok: false,
        error: new RagError(
          `relevance rerank: ${e instanceof Error ? e.message : String(e)}`,
          'RERANK_ERROR',
        ),
      };
    }
    if (!res.ok) {
      return {
        ok: false,
        error: new RagError(
          `decision rerank failed: ${res.error.code}: ${res.error.message}`,
          'RERANK_ERROR',
        ),
      };
    }
    const bad = checkScores(res.value.scores, idxs.length);
    if (bad)
      return {
        ok: false,
        error: new RagError(`relevance rerank: ${bad}`, 'RERANK_ERROR'),
      };
    return { ok: true, value: res.value.scores };
  }
}
