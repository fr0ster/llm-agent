import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  ICoordinatorContext,
  ISubAgent,
  ISubAgentInput,
  PlanStep,
} from '@mcp-abap-adt/llm-agent';
import { SubAgentDispatch } from '../subagent.js';

describe('SubAgentDispatch task composition', () => {
  it('passes objective + verbatim material in the composed task', async () => {
    const captured: { task?: string } = {};
    const fakeSub: ISubAgent = {
      capabilities: {
        kind: 'constrained',
        canDispatchChildren: false,
        contextPolicy: 'optional',
      },
      run: async (input: ISubAgentInput) => {
        captured.task = input.task;
        return { output: 'done' };
      },
    } as unknown as ISubAgent;

    const ctx = {
      inputText: 'RELEASE-TASKS-BLOB',
      registry: new Map([['summarizer', fakeSub]]),
      stepResults: {},
      sessionId: 't',
      plan: {
        steps: [],
        objective: 'Ship the release',
        createdAt: 0,
        source: 'planner-llm',
      },
    } as unknown as ICoordinatorContext;

    const step: PlanStep = {
      id: 's1',
      goal: 'Summarize',
      agent: 'summarizer',
      needsInput: true,
      status: 'pending',
    };

    const res = await new SubAgentDispatch().dispatch(step, ctx);
    assert.equal(res.ok, true);
    assert.match(captured.task ?? '', /RELEASE-TASKS-BLOB/);
    assert.match(captured.task ?? '', /Overall objective: Ship the release/);
  });
});
