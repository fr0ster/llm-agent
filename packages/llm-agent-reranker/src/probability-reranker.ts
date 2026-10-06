import {
  type CallOptions,
  type DecisionAnswer,
  type DecisionEntry,
  type IProbabilityDecision,
  type IReranker,
  type NoulQuestion,
  RagError,
  type RagResult,
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
import { delegateHealth, minimalRerank } from './health.js';

export const PROBABILITY_RERANK_DEFAULT_TASK =
  'Judge whether this passage helps answer the query given as the state.';

export const PROBABILITY_RERANK_DEFAULT_CRITERIA: Readonly<{
  true: DecisionEntry;
  false: DecisionEntry;
}> = Object.freeze({
  true: 'The passage contains information that helps answer the query.',
  false: 'The passage does not help answer the query.',
});

export const PASSAGE_QUESTION = Object.freeze({
  task: PROBABILITY_RERANK_DEFAULT_TASK,
  criteria: PROBABILITY_RERANK_DEFAULT_CRITERIA,
});

export const TOOL_QUESTION = Object.freeze({
  task: 'Judge whether calling this tool would help carry out the request given as the state.' as DecisionEntry,
  criteria: Object.freeze({
    true: 'Calling this tool is a direct step toward carrying out the request.' as DecisionEntry,
    false: 'This tool does not help carry out the request.' as DecisionEntry,
  }),
});

export interface ProbabilityRerankerOptions {
  /** Override the default task wording. The passage is always sent alongside
   *  it — this never replaces the passage. */
  task?: DecisionEntry;
  criteria?: { true?: DecisionEntry; false?: DecisionEntry };
  /** Estimated-token budget per decide() call (~4 chars/token); a positive integer. Default 48000. */
  maxBatchTokens?: number;
  /** Max decide() calls in flight; a positive integer. Default 4. */
  concurrency?: number;
}

/**
 * Rerank RAG results with a probability decision (spec §5.1): the query as the
 * state, one yes/no question per passage, batched under a token budget.
 * `score` becomes P(relevant). Any failed batch fails the whole call.
 */
export class ProbabilityReranker implements IReranker {
  private readonly maxBatchTokens: number;
  private readonly concurrency: number;

  /** @throws Error when `maxBatchTokens` or `concurrency` is not a positive integer. */
  constructor(
    private readonly decision: IProbabilityDecision,
    private readonly options: ProbabilityRerankerOptions = {},
  ) {
    this.maxBatchTokens = options.maxBatchTokens ?? DEFAULT_MAX_BATCH_TOKENS;
    this.concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
    assertPositiveInteger(
      'ProbabilityReranker',
      'maxBatchTokens',
      this.maxBatchTokens,
    );
    assertPositiveInteger(
      'ProbabilityReranker',
      'concurrency',
      this.concurrency,
    );
  }

  async rerank(
    query: string,
    results: RagResult[],
    options?: CallOptions,
  ): Promise<Result<RagResult[], RagError>> {
    if (results.length === 0) return { ok: true, value: results };

    const task = this.options.task ?? PROBABILITY_RERANK_DEFAULT_TASK;
    const criteria =
      this.options.criteria ?? PROBABILITY_RERANK_DEFAULT_CRITERIA;
    const fixed = estimateTokens(JSON.stringify({ task, criteria }));
    const batches = batchByTokens(
      estimateTokens(query),
      results.map((r) => fixed + estimateTokens(r.text)),
      this.maxBatchTokens,
    );
    const waves = await runInWaves(batches, this.concurrency, (idxs) =>
      this.runBatch(query, results, idxs, task, criteria, options),
    );
    if (!waves.ok) return waves;
    const answers: Record<string, DecisionAnswer> = {};
    for (const w of waves.value) Object.assign(answers, w.value);

    const probability: number[] = [];
    for (let i = 0; i < results.length; i++) {
      const a = answers[`r${i}`];
      if (
        a?.type !== 'noul' ||
        typeof a.probability !== 'number' ||
        !Number.isFinite(a.probability)
      ) {
        return {
          ok: false,
          error: new RagError(
            `decision rerank: no yes/no answer for passage r${i}`,
            'RERANK_ERROR',
          ),
        };
      }
      probability.push(a.probability);
    }
    return { ok: true, value: sortByScore(results, probability) };
  }

  /**
   * The decision's own `healthCheck` when it has one, else one minimal decide
   * over one question (spec §17.43 D97).
   */
  async healthCheck(options?: CallOptions): Promise<Result<boolean, RagError>> {
    const decision = this.decision;
    const check = decision.healthCheck;
    if (check) {
      return delegateHealth('decision', () => check.call(decision, options));
    }
    return minimalRerank(this, options);
  }

  private async runBatch(
    query: string,
    results: RagResult[],
    idxs: number[],
    task: DecisionEntry,
    criteria: { true?: DecisionEntry; false?: DecisionEntry },
    options?: CallOptions,
  ): Promise<Result<Record<string, DecisionAnswer>, RagError>> {
    const questions: Record<string, NoulQuestion> = {};
    for (const i of idxs) {
      questions[`r${i}`] = {
        type: 'noul',
        instructions: { task, passage: results[i].text },
        criteria,
      };
    }
    let res: Awaited<ReturnType<IProbabilityDecision['decide']>>;
    try {
      res = await this.decision.decide({ state: query, questions }, options);
    } catch (e) {
      // A throw / rejection is a failed call too: a Result error, never an exception.
      return {
        ok: false,
        error: new RagError(
          `decision rerank failed: ${e instanceof Error ? e.message : String(e)}`,
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
    return { ok: true, value: res.value.answers };
  }
}
