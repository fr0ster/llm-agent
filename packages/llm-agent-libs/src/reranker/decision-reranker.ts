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

export const DECISION_RERANK_DEFAULT_CRITERIA: {
  true: DecisionEntry;
  false: DecisionEntry;
} = {
  true: 'The passage contains information that helps answer the query.',
  false: 'The passage does not help answer the query.',
};

export interface DecisionRerankerOptions {
  /** Override the default task wording. The passage is always sent alongside
   *  it — this never replaces the passage. */
  task?: DecisionEntry;
  criteria?: { true?: DecisionEntry; false?: DecisionEntry };
}

/**
 * Rerank RAG results with a decision model: one call per store, the query as
 * the state, one yes/no question per passage. `score` becomes P(relevant).
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
    const questions: Record<string, NoulQuestion> = {};
    results.forEach((r, i) => {
      questions[`r${i}`] = {
        type: 'noul',
        instructions: { task, passage: r.text },
        criteria,
      };
    });

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

    const scored: Array<{ r: RagResult; i: number }> = [];
    for (let i = 0; i < results.length; i++) {
      const a = res.value.answers[`r${i}`];
      if (a?.type !== 'noul') {
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
}
