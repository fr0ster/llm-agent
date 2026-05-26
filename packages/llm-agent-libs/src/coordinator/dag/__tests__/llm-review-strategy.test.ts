import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DagPlan, ILlm, ReviewInput } from '@mcp-abap-adt/llm-agent';
import { LlmReviewStrategy } from '../llm-review-strategy.js';
import { NoopReviewStrategy } from '../noop-review-strategy.js';

function llm(content: string): ILlm {
  return {
    chat: async () => ({ ok: true, value: { content } }),
  } as unknown as ILlm;
}
const plan: DagPlan = {
  nodes: [{ id: 'n1', goal: 'do it', agent: 'w' }],
  createdAt: 0,
};
const input: ReviewInput = {
  prompt: 'do it',
  plan,
  agents: [{ name: 'w', description: 'worker' }],
  sessionId: 't',
};

describe('LlmReviewStrategy', () => {
  it('returns pass:true on a positive verdict', async () => {
    const v = await new LlmReviewStrategy(llm('{"pass": true}')).review(input);
    assert.deepEqual(v, { pass: true });
  });

  it('returns pass:false with feedback on a negative verdict', async () => {
    const v = await new LlmReviewStrategy(
      llm('{"pass": false, "feedback": "no worker can read tables"}'),
    ).review(input);
    assert.deepEqual(v, {
      pass: false,
      feedback: 'no worker can read tables',
    });
  });

  it('throws on malformed JSON', async () => {
    await assert.rejects(
      () => new LlmReviewStrategy(llm('not json')).review(input),
      /JSON/i,
    );
  });

  it('throws when pass is not a boolean', async () => {
    await assert.rejects(
      () => new LlmReviewStrategy(llm('{"pass": "yes"}')).review(input),
      /boolean 'pass'/,
    );
  });

  it('throws when a rejection has no feedback string', async () => {
    await assert.rejects(
      () => new LlmReviewStrategy(llm('{"pass": false}')).review(input),
      /feedback/,
    );
  });

  it('throws the LLM error when the call is not ok', async () => {
    const failing = {
      chat: async () => ({ ok: false, error: new Error('quota') }),
    } as unknown as ILlm;
    await assert.rejects(
      () => new LlmReviewStrategy(failing).review(input),
      /quota/,
    );
  });
});

describe('NoopReviewStrategy', () => {
  it('always passes', async () => {
    const v = await new NoopReviewStrategy().review(input);
    assert.deepEqual(v, { pass: true });
  });
});
