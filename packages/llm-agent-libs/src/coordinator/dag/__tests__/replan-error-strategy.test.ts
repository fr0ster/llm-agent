import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type DagPlan,
  type ErrorContext,
  type IPlanner,
  NeedsDecompositionError,
  type PlanNode,
} from '@mcp-abap-adt/llm-agent';
import { AbortErrorStrategy } from '../abort-error-strategy.js';
import { ReplanErrorStrategy } from '../replan-error-strategy.js';

const node: PlanNode = { id: 'n1', goal: 'big task' };
const subPlan: DagPlan = { nodes: [{ id: 's1', goal: 'small' }], createdAt: 0 };
function ctx(remainingReplans: number): ErrorContext {
  return {
    task: 'Task: big task',
    remainingReplans,
    agents: [{ name: 'w' }],
    sessionId: 't',
  };
}
function planner(captured: { prompt?: string }): IPlanner {
  return {
    name: 'p',
    plan: async (input) => {
      captured.prompt = input.prompt;
      return subPlan;
    },
  };
}

describe('AbortErrorStrategy', () => {
  it('always aborts', async () => {
    const r = await new AbortErrorStrategy().onNodeFailure(
      node,
      new NeedsDecompositionError('too big'),
      ctx(5),
    );
    assert.deepEqual(r, { action: 'abort' });
  });
});

describe('ReplanErrorStrategy', () => {
  it('replans on NeedsDecompositionError using the composed task + reason', async () => {
    const cap: { prompt?: string } = {};
    const r = await new ReplanErrorStrategy(planner(cap), 4).onNodeFailure(
      node,
      new NeedsDecompositionError('too big'),
      ctx(4),
    );
    assert.deepEqual(r, { action: 'replan', subPlan });
    assert.match(cap.prompt ?? '', /Task: big task/);
    assert.match(cap.prompt ?? '', /too big/);
  });

  it('aborts on a generic error without calling the planner', async () => {
    const cap: { prompt?: string } = {};
    const r = await new ReplanErrorStrategy(planner(cap), 4).onNodeFailure(
      node,
      new Error('mcp timeout'),
      ctx(4),
    );
    assert.deepEqual(r, { action: 'abort' });
    assert.equal(cap.prompt, undefined);
  });

  it('aborts without calling the planner when the budget is exhausted', async () => {
    const cap: { prompt?: string } = {};
    const r = await new ReplanErrorStrategy(planner(cap), 4).onNodeFailure(
      node,
      new NeedsDecompositionError('too big'),
      ctx(0),
    );
    assert.deepEqual(r, { action: 'abort' });
    assert.equal(cap.prompt, undefined);
  });

  it('exposes maxReplans', () => {
    assert.equal(new ReplanErrorStrategy(planner({}), 3).maxReplans, 3);
  });
});
