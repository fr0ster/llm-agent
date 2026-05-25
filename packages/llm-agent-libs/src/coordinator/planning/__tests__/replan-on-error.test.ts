import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ICoordinatorContext, ILlm } from '@mcp-abap-adt/llm-agent';
import { ReplanOnErrorPlanning } from '../replan-on-error.js';

function makeCtx(): ICoordinatorContext {
  return {
    inputText: 'do stuff',
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

describe('ReplanOnErrorPlanning.rebuildPlan parsing', () => {
  it('parses objective and per-step needsInput', async () => {
    const llm = llmReturning(
      '{"objective":"Recover","steps":[{"id":"r1","goal":"Retry","needsInput":true}],"rationale":"R"}',
    );
    const plan = await new ReplanOnErrorPlanning(llm).rebuildPlan(
      makeCtx(),
      [],
    );
    assert.equal(plan.objective, 'Recover');
    assert.equal(plan.steps[0].needsInput, true);
  });

  it('throws when replan output has no steps', async () => {
    const llm = llmReturning('{"objective":"x"}');
    await assert.rejects(
      () => new ReplanOnErrorPlanning(llm).rebuildPlan(makeCtx(), []),
      /Replan returned no steps/,
    );
  });
});
