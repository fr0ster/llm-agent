/**
 * Spec §17.43 D97: the shipped rerankers implement the cheap
 * `IReranker.healthCheck`. Noop → true; LlmReranker → its LLM's healthCheck,
 * else one minimal call; ProbabilityReranker / RelevanceReranker → their
 * decision's healthCheck, else one minimal decide / score.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DecisionError,
  type DecisionRequest,
  type IProbabilityDecision,
  type IRelevanceDecision,
  LlmError,
  type RelevanceRequest,
} from '@mcp-abap-adt/llm-agent';
import {
  LlmReranker,
  NoopReranker,
  ProbabilityReranker,
  RelevanceReranker,
} from '../index.js';
import { makeLlm } from './fake-llm.js';

describe('NoopReranker.healthCheck', () => {
  it('answers true', async () => {
    assert.deepEqual(await new NoopReranker().healthCheck(), {
      ok: true,
      value: true,
    });
  });
});

describe('LlmReranker.healthCheck', () => {
  it("delegates to the LLM's healthCheck, no chat", async () => {
    const llm = makeLlm([]);
    let probed = 0;
    const withHealth = Object.assign(llm, {
      healthCheck: async () => {
        probed++;
        return { ok: true as const, value: true };
      },
    });
    const r = await new LlmReranker(withHealth).healthCheck();
    assert.deepEqual(r, { ok: true, value: true });
    assert.equal(probed, 1);
    assert.equal(llm.callCount, 0, 'no chat call');
  });

  it("the LLM's healthCheck false → false; ok:false → ok:false naming it", async () => {
    const no = Object.assign(makeLlm([]), {
      healthCheck: async () => ({ ok: true as const, value: false }),
    });
    assert.deepEqual(await new LlmReranker(no).healthCheck(), {
      ok: true,
      value: false,
    });
    const down = Object.assign(makeLlm([]), {
      healthCheck: async () => ({
        ok: false as const,
        error: new LlmError('llm down', 'LLM_UNAVAILABLE'),
      }),
    });
    const r = await new LlmReranker(down).healthCheck();
    assert.equal(r.ok, false);
    assert.ok(!r.ok);
    assert.match(r.error.message, /LLM_UNAVAILABLE.*llm down/);
  });

  it("the LLM's healthCheck rejects → ok:false, never a throw", async () => {
    const llm = Object.assign(makeLlm([]), {
      healthCheck: async (): Promise<never> => {
        throw new Error('socket hang up');
      },
    });
    const r = await new LlmReranker(llm).healthCheck();
    assert.ok(!r.ok);
    assert.match(r.error.message, /socket hang up/);
  });

  it('without an LLM healthCheck: one minimal rerank call', async () => {
    const llm = makeLlm([{ content: '[0.9]' }]);
    assert.deepEqual(await new LlmReranker(llm).healthCheck(), {
      ok: true,
      value: true,
    });
    assert.equal(llm.callCount, 1);
    const bad = makeLlm([new Error('quota')]);
    const r = await new LlmReranker(bad).healthCheck();
    assert.ok(!r.ok);
    assert.match(r.error.message, /quota/);
  });
});

function probability(opts: {
  health?: IProbabilityDecision['healthCheck'];
}): IProbabilityDecision & { decides: DecisionRequest[] } {
  const decides: DecisionRequest[] = [];
  return {
    decides,
    decide: async (req) => {
      decides.push(req);
      const answers = Object.fromEntries(
        Object.keys(req.questions).map((k) => [
          k,
          { type: 'noul' as const, probability: 0.5 },
        ]),
      );
      return { ok: true, value: { answers, model: 'fake' } };
    },
    ...(opts.health ? { healthCheck: opts.health } : {}),
  };
}

function relevance(opts: {
  health?: IRelevanceDecision['healthCheck'];
  fail?: boolean;
}): IRelevanceDecision & { scores: RelevanceRequest[] } {
  const scores: RelevanceRequest[] = [];
  return {
    scores,
    score: async (req) => {
      scores.push(req);
      if (opts.fail)
        return {
          ok: false,
          error: new DecisionError('deployment gone', 'DECISION_UNAVAILABLE'),
        };
      return {
        ok: true,
        value: {
          model: 'fake',
          scores: req.passages.map((_, index) => ({ index, score: 1 })),
        },
      };
    },
    ...(opts.health ? { healthCheck: opts.health } : {}),
  };
}

describe('ProbabilityReranker.healthCheck', () => {
  it("delegates to the decision's healthCheck, no decide", async () => {
    const d = probability({
      health: async () => ({ ok: true, value: true }),
    });
    assert.deepEqual(await new ProbabilityReranker(d).healthCheck(), {
      ok: true,
      value: true,
    });
    assert.equal(d.decides.length, 0);
  });

  it('the decision healthCheck ok:false → ok:false naming its code', async () => {
    const d = probability({
      health: async () => ({
        ok: false,
        error: new DecisionError('bad key', 'DECISION_AUTH'),
      }),
    });
    const r = await new ProbabilityReranker(d).healthCheck();
    assert.ok(!r.ok);
    assert.match(r.error.message, /DECISION_AUTH.*bad key/);
  });

  it('the decision healthCheck rejects → ok:false', async () => {
    const d = probability({
      health: async (): Promise<never> => {
        throw new Error('boom');
      },
    });
    const r = await new ProbabilityReranker(d).healthCheck();
    assert.ok(!r.ok);
    assert.match(r.error.message, /boom/);
  });

  it('without a decision healthCheck: one minimal decide over one question', async () => {
    const d = probability({});
    assert.deepEqual(await new ProbabilityReranker(d).healthCheck(), {
      ok: true,
      value: true,
    });
    assert.equal(d.decides.length, 1);
    assert.equal(Object.keys(d.decides[0].questions).length, 1);
  });
});

describe('RelevanceReranker.healthCheck', () => {
  it("delegates to the decision's healthCheck, no score", async () => {
    const d = relevance({ health: async () => ({ ok: true, value: false }) });
    assert.deepEqual(await new RelevanceReranker(d).healthCheck(), {
      ok: true,
      value: false,
    });
    assert.equal(d.scores.length, 0);
  });

  it('without a decision healthCheck: one minimal score over one passage; failure → ok:false', async () => {
    const good = relevance({});
    assert.deepEqual(await new RelevanceReranker(good).healthCheck(), {
      ok: true,
      value: true,
    });
    assert.equal(good.scores.length, 1);
    assert.equal(good.scores[0].passages.length, 1);
    const bad = relevance({ fail: true });
    const r = await new RelevanceReranker(bad).healthCheck();
    assert.ok(!r.ok);
    assert.match(r.error.message, /DECISION_UNAVAILABLE.*deployment gone/);
  });
});
