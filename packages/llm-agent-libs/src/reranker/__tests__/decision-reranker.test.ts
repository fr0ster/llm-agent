import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DecisionError,
  type DecisionRequest,
  type IDecisionModel,
  type RagResult,
} from '@mcp-abap-adt/llm-agent';
import {
  DECISION_RERANK_DEFAULT_CRITERIA,
  DECISION_RERANK_DEFAULT_TASK,
  DecisionReranker,
} from '../decision-reranker.js';

const results: RagResult[] = [
  { text: 'alpha', metadata: { id: 'a' }, score: 0.9 },
  { text: 'beta', metadata: { id: 'b' }, score: 0.8 },
  { text: 'gamma', metadata: { id: 'c' }, score: 0.7 },
];

function fakeModel(probs: number[]) {
  const seen: DecisionRequest[] = [];
  const model: IDecisionModel = {
    decide: async (req) => {
      seen.push(req);
      const answers: Record<string, { type: 'noul'; probability: number }> = {};
      probs.forEach((p, i) => {
        answers[`r${i}`] = { type: 'noul', probability: p };
      });
      return { ok: true, value: { model: 'fake', answers } };
    },
  };
  return { model, seen };
}

describe('DECISION_RERANK_DEFAULT_CRITERIA', () => {
  it('is frozen, so a consumer cannot change every reranker', () => {
    assert.ok(Object.isFrozen(DECISION_RERANK_DEFAULT_CRITERIA));
  });
});

describe('DecisionReranker', () => {
  it('empty input → unchanged, no call', async () => {
    const { model, seen } = fakeModel([]);
    const r = await new DecisionReranker(model).rerank('q', []);
    assert.ok(r.ok);
    assert.deepEqual(r.value, []);
    assert.equal(seen.length, 0);
  });

  it('one call: query as state, one noul question per passage', async () => {
    const { model, seen } = fakeModel([0.1, 0.2, 0.3]);
    await new DecisionReranker(model).rerank('the query', results);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].state, 'the query');
    assert.deepEqual(Object.keys(seen[0].questions), ['r0', 'r1', 'r2']);
    assert.deepEqual(seen[0].questions.r1, {
      type: 'noul',
      instructions: { task: DECISION_RERANK_DEFAULT_TASK, passage: 'beta' },
      criteria: DECISION_RERANK_DEFAULT_CRITERIA,
    });
  });

  it('scores = probability, sorted descending, text/metadata untouched', async () => {
    const { model } = fakeModel([0.2, 0.9, 0.5]);
    const r = await new DecisionReranker(model).rerank('q', results);
    assert.ok(r.ok);
    assert.deepEqual(
      r.value.map((x) => [x.text, x.score, x.metadata.id]),
      [
        ['beta', 0.9, 'b'],
        ['gamma', 0.5, 'c'],
        ['alpha', 0.2, 'a'],
      ],
    );
  });

  it('ties keep the original order (stable)', async () => {
    const { model } = fakeModel([0.5, 0.5, 0.5]);
    const r = await new DecisionReranker(model).rerank('q', results);
    assert.ok(r.ok);
    assert.deepEqual(
      r.value.map((x) => x.text),
      ['alpha', 'beta', 'gamma'],
    );
  });

  it('a task override keeps every passage', async () => {
    const { model, seen } = fakeModel([0.1, 0.2, 0.3]);
    await new DecisionReranker(model, { task: 'Custom task' }).rerank(
      'q',
      results,
    );
    results.forEach((res, i) => {
      assert.deepEqual(seen[0].questions[`r${i}`], {
        type: 'noul',
        instructions: { task: 'Custom task', passage: res.text },
        criteria: DECISION_RERANK_DEFAULT_CRITERIA,
      });
    });
  });

  it('a criteria override replaces only the criteria', async () => {
    const { model, seen } = fakeModel([0.1, 0.2, 0.3]);
    const criteria = { true: 'relevant', false: 'irrelevant' };
    await new DecisionReranker(model, { criteria }).rerank('q', results);
    const q = seen[0].questions.r0;
    assert.equal(q.type, 'noul');
    if (q.type === 'noul') {
      assert.deepEqual(q.criteria, criteria);
      assert.deepEqual(q.instructions, {
        task: DECISION_RERANK_DEFAULT_TASK,
        passage: 'alpha',
      });
    }
  });

  it('a model error → RERANK_ERROR carrying the decision code', async () => {
    const model: IDecisionModel = {
      decide: async () => ({
        ok: false,
        error: new DecisionError('stale key', 'DECISION_AUTH'),
      }),
    };
    const r = await new DecisionReranker(model).rerank('q', results);
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'RERANK_ERROR');
    assert.match(r.error.message, /DECISION_AUTH/);
  });

  it('a missing answer → RERANK_ERROR', async () => {
    const { model } = fakeModel([0.1, 0.2]); // r2 missing
    const r = await new DecisionReranker(model).rerank('q', results);
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'RERANK_ERROR');
  });

  it('passes call options through', async () => {
    let got: unknown;
    const model: IDecisionModel = {
      decide: async (_req, opts) => {
        got = opts;
        return {
          ok: true,
          value: {
            model: 'f',
            answers: { r0: { type: 'noul', probability: 1 } },
          },
        };
      },
    };
    const opts = { sessionId: 's-1' };
    await new DecisionReranker(model).rerank('q', [results[0]], opts);
    assert.equal(got, opts);
  });
});
