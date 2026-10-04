import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DecisionError,
  type DecisionRequest,
  type IDecisionModel,
  type RagResult,
} from '@mcp-abap-adt/llm-agent';
import {
  DecisionReranker,
  PASSAGE_QUESTION,
  TOOL_QUESTION,
} from '../decision-reranker.js';

const mk = (n: number, len = 10): RagResult[] =>
  Array.from({ length: n }, (_, i) => ({
    text: `p${i}`.padEnd(len, 'x'),
    metadata: { id: `p${i}` },
    score: 0.5,
  }));

function model(prob: (passage: string) => number, failOn?: number) {
  const calls: DecisionRequest[] = [];
  const m: IDecisionModel = {
    decide: async (req) => {
      calls.push(req);
      if (failOn !== undefined && calls.length === failOn) {
        return {
          ok: false,
          error: new DecisionError('x', 'DECISION_UNAVAILABLE'),
        };
      }
      const answers = Object.fromEntries(
        Object.entries(req.questions).map(([k, qq]) => [
          k,
          {
            type: 'noul' as const,
            probability: prob(
              String(
                (qq as { instructions: { passage: string } }).instructions
                  .passage,
              ),
            ),
          },
        ]),
      );
      return { ok: true, value: { model: 'f', answers } };
    },
  };
  return { m, calls };
}

describe('DecisionReranker presets', () => {
  it('TOOL_QUESTION and PASSAGE_QUESTION are frozen and distinct', () => {
    assert.ok(
      Object.isFrozen(TOOL_QUESTION) && Object.isFrozen(PASSAGE_QUESTION),
    );
    assert.notEqual(TOOL_QUESTION.task, PASSAGE_QUESTION.task);
  });
});

describe('DecisionReranker batching', () => {
  it('splits by the token budget and merges by score', async () => {
    const { m, calls } = model(
      (p) => Number(p.slice(1).replace(/x+$/, '')) / 100,
    );
    const results = mk(30, 400);
    const r = await new DecisionReranker(m, { maxBatchTokens: 1_000 }).rerank(
      'q',
      results,
    );
    assert.ok(r.ok);
    assert.ok(
      calls.length > 1,
      `expected several batches, got ${calls.length}`,
    );
    for (const c of calls) {
      const text = JSON.stringify(c);
      assert.ok(text.length / 4 <= 1_000 + 200, 'batch stays near the budget');
    }
    assert.equal(r.value[0].metadata.id, 'p29');
    assert.equal(r.value.length, 30);
  });

  it('one failed batch fails the call (no partial merge)', async () => {
    const { m } = model(() => 0.5, 2);
    const r = await new DecisionReranker(m, { maxBatchTokens: 1_000 }).rerank(
      'q',
      mk(30, 400),
    );
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'RERANK_ERROR');
  });

  it('small inputs are still one call', async () => {
    const { m, calls } = model(() => 0.5);
    await new DecisionReranker(m).rerank('q', mk(5));
    assert.equal(calls.length, 1);
  });
});
