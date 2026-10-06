import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DecisionError,
  type IProbabilityDecision,
  type LlmComponent,
  SmartAgentError,
} from '../../index.js';

describe('DecisionError', () => {
  it('is a SmartAgentError with its own name and the given code', () => {
    const e = new DecisionError('bad', 'DECISION_AUTH');
    assert.ok(e instanceof SmartAgentError);
    assert.equal(e.name, 'DecisionError');
    assert.equal(e.code, 'DECISION_AUTH');
    assert.equal(e.message, 'bad');
  });

  it('defaults to DECISION_ERROR', () => {
    assert.equal(new DecisionError('x').code, 'DECISION_ERROR');
  });
});

describe('IProbabilityDecision', () => {
  it('is implementable with Result, not throw', async () => {
    const m: IProbabilityDecision = {
      model: 'fake',
      decide: async () => ({
        ok: true,
        value: {
          model: 'fake-1',
          answers: { q: { type: 'noul', probability: 0.5 } },
        },
      }),
    };
    const r = await m.decide({
      state: 's',
      questions: { q: { type: 'noul' } },
    });
    assert.ok(r.ok);
  });

  it("LlmComponent accepts 'decision'", () => {
    const c: LlmComponent = 'decision';
    assert.equal(c, 'decision');
  });
});
