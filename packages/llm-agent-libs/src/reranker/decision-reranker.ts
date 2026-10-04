import {
  type CallOptions,
  type DecisionEntry,
  type IDecisionModel,
  type NoulQuestion,
  RagError,
  type RagResult,
  type Result,
} from '@mcp-abap-adt/llm-agent';
import type { IReranker } from './types.js';

export const DECISION_RERANK_DEFAULT_TASK =
  'Judge whether this passage helps answer the query given as the state.';

export const DECISION_RERANK_DEFAULT_CRITERIA: Readonly<{
  true: DecisionEntry;
  false: DecisionEntry;
}> = Object.freeze({
  true: 'The passage contains information that helps answer the query.',
  false: 'The passage does not help answer the query.',
});

export const PASSAGE_QUESTION = Object.freeze({
  task: DECISION_RERANK_DEFAULT_TASK,
  criteria: DECISION_RERANK_DEFAULT_CRITERIA,
});

export const TOOL_QUESTION = Object.freeze({
  task: 'Judge whether calling this tool would help carry out the request given as the state.' as DecisionEntry,
  criteria: Object.freeze({
    true: 'Calling this tool is a direct step toward carrying out the request.' as DecisionEntry,
    false: 'This tool does not help carry out the request.' as DecisionEntry,
  }),
});

const DEFAULT_MAX_BATCH_TOKENS = 48_000;
const DEFAULT_CONCURRENCY = 4;

export interface DecisionRerankerOptions {
  /** Override the default task wording. The passage is always sent alongside
   *  it — this never replaces the passage. */
  task?: DecisionEntry;
  criteria?: { true?: DecisionEntry; false?: DecisionEntry };
  /** Estimated-token budget per decide() call (~4 chars/token). Default 48000. */
  maxBatchTokens?: number;
  /** Max decide() calls in flight. Default 4. */
  concurrency?: number;
}

const estimateTokens = (s: string): number => Math.ceil(s.length / 4);

/**
 * Rerank RAG results with a decision model: the query as the state, one
 * yes/no question per passage, batched under a token budget. `score` becomes
 * P(relevant). Any failed batch fails the whole call.
 */
export class DecisionReranker implements IReranker {
  constructor(
    private readonly model: IDecisionModel,
    private readonly options: DecisionRerankerOptions = {},
  ) {}

  async rerank(
    query: string,
    results: RagResult[],
    options?: CallOptions,
  ): Promise<Result<RagResult[], RagError>> {
    if (results.length === 0) return { ok: true, value: results };

    const task = this.options.task ?? DECISION_RERANK_DEFAULT_TASK;
    const criteria = this.options.criteria ?? DECISION_RERANK_DEFAULT_CRITERIA;
    const budget = this.options.maxBatchTokens ?? DEFAULT_MAX_BATCH_TOKENS;
    const concurrency = Math.max(
      1,
      this.options.concurrency ?? DEFAULT_CONCURRENCY,
    );

    const fixed = estimateTokens(JSON.stringify({ task, criteria }));
    const stateCost = estimateTokens(query);
    const batches: number[][] = [];
    let cur: number[] = [];
    let used = stateCost;
    results.forEach((r, i) => {
      const cost = fixed + estimateTokens(r.text);
      if (cur.length > 0 && used + cost > budget) {
        batches.push(cur);
        cur = [];
        used = stateCost;
      }
      cur.push(i);
      used += cost;
    });
    if (cur.length > 0) batches.push(cur);

    const answers: Record<string, { type: string; probability?: number }> = {};
    for (let s = 0; s < batches.length; s += concurrency) {
      const slice = batches.slice(s, s + concurrency);
      const settled = await Promise.all(
        slice.map((idxs) =>
          this.runBatch(query, results, idxs, task, criteria, options),
        ),
      );
      for (const res of settled) {
        if (!res.ok) return res;
        Object.assign(answers, res.value);
      }
    }

    const scored: Array<{ r: RagResult; i: number }> = [];
    for (let i = 0; i < results.length; i++) {
      const a = answers[`r${i}`];
      if (a?.type !== 'noul' || typeof a.probability !== 'number') {
        return {
          ok: false,
          error: new RagError(
            `decision rerank: no yes/no answer for passage r${i}`,
            'RERANK_ERROR',
          ),
        };
      }
      scored.push({ r: { ...results[i], score: a.probability }, i });
    }
    scored.sort((x, y) => y.r.score - x.r.score || x.i - y.i);
    return { ok: true, value: scored.map((s) => s.r) };
  }

  private async runBatch(
    query: string,
    results: RagResult[],
    idxs: number[],
    task: DecisionEntry,
    criteria: { true?: DecisionEntry; false?: DecisionEntry },
    options?: CallOptions,
  ): Promise<
    Result<Record<string, { type: string; probability?: number }>, RagError>
  > {
    const questions: Record<string, NoulQuestion> = {};
    for (const i of idxs) {
      questions[`r${i}`] = {
        type: 'noul',
        instructions: { task, passage: results[i].text },
        criteria,
      };
    }
    const res = await this.model.decide({ state: query, questions }, options);
    if (!res.ok) {
      return {
        ok: false,
        error: new RagError(
          `decision rerank failed: ${res.error.code}: ${res.error.message}`,
          'RERANK_ERROR',
        ),
      };
    }
    return { ok: true, value: res.value.answers as never };
  }
}
