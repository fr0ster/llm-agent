import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  ICoordinatorContext,
  ISubAgent,
  ISubAgentInput,
  PlanStep,
  StepResult,
} from '@mcp-abap-adt/llm-agent';
import { SubAgentDispatch } from '../subagent.js';

class CapturingSubAgent implements ISubAgent {
  readonly name = 'capturer';
  readonly description = 'records the last input it received';
  lastInput?: ISubAgentInput;
  async run(input: ISubAgentInput) {
    this.lastInput = input;
    return { output: 'ok' };
  }
}

function step(id: string, goal: string, agent?: string): PlanStep {
  return { id, goal, agent, status: 'pending' };
}

function result(
  stepId: string,
  output: string,
  ok: boolean,
  error?: string,
): StepResult {
  return { stepId, output, durationMs: 1, ok, error };
}

describe('SubAgentDispatch briefing', () => {
  it('passes a populated briefing with known and tried built from stepResults', async () => {
    const sub = new CapturingSubAgent();
    const registry = new Map([['capturer', sub]]);
    const s1 = step('s1', 'Find file', 'capturer');
    const s2 = step('s2', 'Read file', 'capturer');
    const ctx: ICoordinatorContext = {
      inputText: 'fix the bug',
      registry,
      stepResults: {
        s1: result('s1', 'Found at src/foo.ts', true),
      },
      sessionId: 'sess-1',
      plan: { steps: [s1, s2], createdAt: 0, source: 'manual' },
    } as unknown as ICoordinatorContext;

    await new SubAgentDispatch().dispatch(s2, ctx);

    assert.ok(sub.lastInput, 'subagent must have been called');
    assert.equal(sub.lastInput?.task, 'Read file');
    assert.equal(sub.lastInput?.briefing?.goal, 'fix the bug');
    assert.deepEqual(sub.lastInput?.briefing?.known, [
      's1 (Find file): Found at src/foo.ts',
    ]);
    assert.deepEqual(sub.lastInput?.briefing?.tried, []);
  });

  it('passes failed prior step into briefing.tried', async () => {
    const sub = new CapturingSubAgent();
    const registry = new Map([['capturer', sub]]);
    const s1 = step('s1', 'Grep src/', 'capturer');
    const s2 = step('s2', 'Try another approach', 'capturer');
    const ctx: ICoordinatorContext = {
      inputText: 'find the symbol',
      registry,
      stepResults: {
        s1: result('s1', '', false, 'no matches'),
      },
      sessionId: 'sess-1',
      plan: { steps: [s1, s2], createdAt: 0, source: 'manual' },
    } as unknown as ICoordinatorContext;

    await new SubAgentDispatch().dispatch(s2, ctx);

    assert.deepEqual(sub.lastInput?.briefing?.tried, [
      's1 (Grep src/) — failed: no matches',
    ]);
  });

  it('uses step.inputTemplate as task when provided', async () => {
    const sub = new CapturingSubAgent();
    const registry = new Map([['capturer', sub]]);
    const s2: PlanStep = {
      id: 's2',
      goal: 'high-level goal',
      agent: 'capturer',
      inputTemplate: 'Detailed task: do {{goal}}',
      status: 'pending',
    };
    const ctx: ICoordinatorContext = {
      inputText: 'top',
      registry,
      stepResults: {},
      sessionId: 'sess-1',
      plan: { steps: [s2], createdAt: 0, source: 'manual' },
    } as unknown as ICoordinatorContext;

    await new SubAgentDispatch().dispatch(s2, ctx);

    assert.equal(sub.lastInput?.task, 'Detailed task: do high-level goal');
    // briefing.goal still reflects ctx.inputText (the bigger picture)
    assert.equal(sub.lastInput?.briefing?.goal, 'top');
  });
});
