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
      /no steps array/,
    );
  });

  it('throws when a step has no goal', async () => {
    const llm = llmReturning(
      '{"objective":"x","steps":[{"id":"s1","goal":""}]}',
    );
    await assert.rejects(
      () => new OneShotPlanning(llm).buildInitialPlan(makeCtx()),
      /missing a goal/,
    );
  });

  it('throws when output has both clarification and steps', async () => {
    const llm = llmReturning(
      '{"clarification":"huh?","steps":[{"id":"s1","goal":"do X"}]}',
    );
    await assert.rejects(
      () => new OneShotPlanning(llm).buildInitialPlan(makeCtx()),
      /both a clarification and a steps array/,
    );
  });

  it('returns an empty-steps plan for explicit steps:[] (answer-directly signal)', async () => {
    const llm = llmReturning('{"steps":[]}');
    const plan = await new OneShotPlanning(llm).buildInitialPlan(makeCtx());
    assert.equal(plan.steps.length, 0);
    assert.equal(plan.clarification, undefined);
    assert.equal(plan.source, 'planner-llm');
  });

  it('returns an empty-steps plan even when an objective is present (steps:[] wins)', async () => {
    const llm = llmReturning('{"objective":"Answer directly","steps":[]}');
    const plan = await new OneShotPlanning(llm).buildInitialPlan(makeCtx());
    assert.equal(plan.steps.length, 0);
    assert.equal(plan.clarification, undefined);
  });

  it('throws when clarification is combined with an empty steps array', async () => {
    const llm = llmReturning('{"clarification":"huh?","steps":[]}');
    await assert.rejects(
      () => new OneShotPlanning(llm).buildInitialPlan(makeCtx()),
      /both a clarification and a steps array/,
    );
  });
});
