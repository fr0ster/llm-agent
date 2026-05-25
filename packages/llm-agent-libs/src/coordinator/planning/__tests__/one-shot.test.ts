import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ICoordinatorContext, ILlm } from '@mcp-abap-adt/llm-agent';
import { OneShotPlanning } from '../one-shot.js';

function makeCtx(): ICoordinatorContext {
  return {
    inputText: 'Summarize this: a, b, c',
    registry: new Map(),
    stepResults: {},
    sessionId: 't',
  } as unknown as ICoordinatorContext;
}

function llmReturning(content: string): ILlm {
  return {
    chat: async () => ({ ok: true, value: { content } }),
  } as unknown as ILlm;
}

describe('OneShotPlanning parsing', () => {
  it('parses objective and per-step needsInput', async () => {
    const llm = llmReturning(
      '{"objective":"Ship checklist","steps":[{"id":"s1","goal":"Summarize","needsInput":true}],"rationale":"R"}',
    );
    const plan = await new OneShotPlanning(llm).buildInitialPlan(makeCtx());
    assert.equal(plan.objective, 'Ship checklist');
    assert.equal(plan.steps[0].needsInput, true);
    assert.equal(plan.clarification, undefined);
  });

  it('returns a clarification plan with no steps', async () => {
    const llm = llmReturning('{"clarification":"What should I summarize?"}');
    const plan = await new OneShotPlanning(llm).buildInitialPlan(makeCtx());
    assert.equal(plan.clarification, 'What should I summarize?');
    assert.equal(plan.steps.length, 0);
  });

  it('throws when output has neither steps nor clarification', async () => {
    const llm = llmReturning('{"objective":"x"}');
    await assert.rejects(
      () => new OneShotPlanning(llm).buildInitialPlan(makeCtx()),
      /neither steps nor a clarification/,
    );
  });
});
