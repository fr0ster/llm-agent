import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  DagPlan,
  ExecutionFailureInput,
  ILlm,
  NodeResult,
  ReviewInput,
} from '@mcp-abap-adt/llm-agent';
import { ClarifySignal, NeedInfoSignal } from '@mcp-abap-adt/llm-agent';
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
    const r = await new LlmReviewStrategy(llm('{"pass": true}')).review(input);
    // `usage` lives on the wrapper now (undefined here since the stub omits it).
    assert.equal(r.verdict.pass, true);
  });

  it('returns pass:false with feedback on a negative verdict', async () => {
    const r = await new LlmReviewStrategy(
      llm('{"pass": false, "feedback": "no worker can read tables"}'),
    ).review(input);
    assert.equal(r.verdict.pass, false);
    if (r.verdict.pass === false) {
      assert.equal(r.verdict.feedback, 'no worker can read tables');
    }
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

  it('review() throws ClarifySignal when the critic asks the user', async () => {
    await assert.rejects(
      () =>
        new LlmReviewStrategy(llm('{"clarify":"confirm overwrite?"}')).review(
          input,
        ),
      (e: unknown) => e instanceof ClarifySignal,
    );
  });

  const failInput: ExecutionFailureInput = {
    objective: 'build it',
    plan: { nodes: [{ id: 'n1', goal: 'do', agent: 'w' }], createdAt: 0 },
    trace: [
      {
        nodeId: 'n0',
        output: 'created table T',
        status: 'done',
        durationMs: 1,
      },
    ] as NodeResult[],
    failedNodeId: 'n1',
    error: 'table already exists',
    agents: [{ name: 'w', description: 'worker' }],
    sessionId: 't',
  };

  it('reviewExecutionFailure parses a revise decision', async () => {
    const s = new LlmReviewStrategy(
      llm(
        '{"action":"revise","plan":{"nodes":[{"id":"r1","goal":"modify table T","agent":"w"}],"createdAt":0}}',
      ),
    );
    const r = await s.reviewExecutionFailure(failInput);
    assert.equal(r.decision.action, 'revise');
    assert.equal(
      r.decision.action === 'revise'
        ? r.decision.revisedPlan.nodes[0].goal
        : '',
      'modify table T',
    );
  });

  it('reviewExecutionFailure parses an abort decision', async () => {
    const s = new LlmReviewStrategy(llm('{"action":"abort"}'));
    const r = await s.reviewExecutionFailure(failInput);
    assert.equal(r.decision.action, 'abort');
  });

  it('reviewExecutionFailure throws on malformed JSON', async () => {
    const s = new LlmReviewStrategy(llm('not json'));
    await assert.rejects(() => s.reviewExecutionFailure(failInput), /JSON/i);
  });

  it('reviewExecutionFailure throws on a revise with no nodes', async () => {
    const s = new LlmReviewStrategy(
      llm('{"action":"revise","plan":{"nodes":[],"createdAt":0}}'),
    );
    await assert.rejects(
      () => s.reviewExecutionFailure(failInput),
      /no nodes|empty|nodes/i,
    );
  });

  it('reviewExecutionFailure throws NeedInfoSignal on a needInfo verdict', async () => {
    await assert.rejects(
      () =>
        new LlmReviewStrategy(
          llm('{"needInfo":"does object exist?"}'),
        ).reviewExecutionFailure(failInput),
      (e: unknown) => e instanceof NeedInfoSignal,
    );
  });

  it('reviewExecutionFailure throws ClarifySignal on a clarify verdict', async () => {
    await assert.rejects(
      () =>
        new LlmReviewStrategy(
          llm('{"clarify":"pick A or B"}'),
        ).reviewExecutionFailure(failInput),
      (e: unknown) => e instanceof ClarifySignal,
    );
  });

  it('review() attaches LLM usage onto NeedInfoSignal', async () => {
    const usage = { promptTokens: 4, completionTokens: 1, totalTokens: 5 };
    const stub = {
      chat: async () => ({
        ok: true,
        value: { content: '{"needInfo":"q?"}', usage },
      }),
    } as unknown as ILlm;
    await assert.rejects(
      () => new LlmReviewStrategy(stub).review(input),
      (e: unknown) => e instanceof NeedInfoSignal && e.usage?.totalTokens === 5,
    );
  });

  it('review() attaches LLM usage onto ClarifySignal', async () => {
    const usage = { promptTokens: 4, completionTokens: 1, totalTokens: 5 };
    const stub = {
      chat: async () => ({
        ok: true,
        value: { content: '{"clarify":"yes?"}', usage },
      }),
    } as unknown as ILlm;
    await assert.rejects(
      () => new LlmReviewStrategy(stub).review(input),
      (e: unknown) => e instanceof ClarifySignal && e.usage?.totalTokens === 5,
    );
  });

  it('reviewExecutionFailure attaches LLM usage onto NeedInfoSignal', async () => {
    const usage = { promptTokens: 6, completionTokens: 2, totalTokens: 8 };
    const stub = {
      chat: async () => ({
        ok: true,
        value: { content: '{"needInfo":"q?"}', usage },
      }),
    } as unknown as ILlm;
    await assert.rejects(
      () => new LlmReviewStrategy(stub).reviewExecutionFailure(failInput),
      (e: unknown) => e instanceof NeedInfoSignal && e.usage?.totalTokens === 8,
    );
  });
});

describe('NoopReviewStrategy', () => {
  it('always passes', async () => {
    const r = await new NoopReviewStrategy().review(input);
    assert.deepEqual(r, { verdict: { pass: true } });
  });

  it('reviewExecutionFailure always aborts', async () => {
    const r = await new NoopReviewStrategy().reviewExecutionFailure({
      plan: { nodes: [], createdAt: 0 },
      trace: [],
      failedNodeId: 'x',
      error: 'e',
      agents: [],
      sessionId: 't',
    });
    assert.deepEqual(r, { decision: { action: 'abort' } });
  });
});
