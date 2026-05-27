import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  DagPlan,
  ErrorContext,
  ExecutionFailureInput,
  IReviewStrategy,
  PlanNode,
} from '@mcp-abap-adt/llm-agent';
import { ReviewerErrorStrategy } from '../reviewer-error-strategy.js';

const node: PlanNode = { id: 'n1', goal: 'do' };
const plan: DagPlan = { nodes: [node], objective: 'O', createdAt: 0 };
const revised: DagPlan = { nodes: [{ id: 'r1', goal: 'fix' }], createdAt: 0 };

function ctx(over: Partial<ErrorContext> = {}): ErrorContext {
  return {
    task: 'Task: do',
    remainingReplans: 4,
    agents: [{ name: 'w' }],
    sessionId: 't',
    plan,
    completedResults: [
      { nodeId: 'n0', output: 'state', status: 'done', durationMs: 1 },
    ],
    ...over,
  };
}
function reviewer(
  cap: { input?: ExecutionFailureInput },
  decision: Awaited<
    ReturnType<NonNullable<IReviewStrategy['reviewExecutionFailure']>>
  >,
): IReviewStrategy {
  return {
    name: 'r',
    review: async () => ({ pass: true }),
    reviewExecutionFailure: async (input) => {
      cap.input = input;
      return decision;
    },
  };
}

describe('ReviewerErrorStrategy', () => {
  it('maps a revise decision to a revise reaction and forwards plan+trace', async () => {
    const cap: { input?: ExecutionFailureInput } = {};
    const r = await new ReviewerErrorStrategy(
      reviewer(cap, { action: 'revise', revisedPlan: revised }),
    ).onNodeFailure(node, new Error('boom'), ctx());
    assert.deepEqual(r, { action: 'revise', revisedPlan: revised });
    assert.equal(cap.input?.failedNodeId, 'n1');
    assert.equal(cap.input?.objective, 'O');
    assert.equal(cap.input?.trace.length, 1);
  });

  it('maps an abort decision to abort', async () => {
    const r = await new ReviewerErrorStrategy(
      reviewer({}, { action: 'abort' }),
    ).onNodeFailure(node, new Error('boom'), ctx());
    assert.deepEqual(r, { action: 'abort' });
  });

  it('aborts without calling the reviewer when budget exhausted', async () => {
    const cap: { input?: ExecutionFailureInput } = {};
    const r = await new ReviewerErrorStrategy(
      reviewer(cap, { action: 'revise', revisedPlan: revised }),
    ).onNodeFailure(node, new Error('boom'), ctx({ remainingReplans: 0 }));
    assert.deepEqual(r, { action: 'abort' });
    assert.equal(cap.input, undefined);
  });

  it('aborts when the reviewer cannot do recovery (no method)', async () => {
    const bare: IReviewStrategy = {
      name: 'r',
      review: async () => ({ pass: true }),
    };
    const r = await new ReviewerErrorStrategy(bare).onNodeFailure(
      node,
      new Error('boom'),
      ctx(),
    );
    assert.deepEqual(r, { action: 'abort' });
  });

  it('aborts when plan/completedResults are absent', async () => {
    const cap: { input?: ExecutionFailureInput } = {};
    const r = await new ReviewerErrorStrategy(
      reviewer(cap, { action: 'revise', revisedPlan: revised }),
    ).onNodeFailure(node, new Error('boom'), ctx({ plan: undefined }));
    assert.deepEqual(r, { action: 'abort' });
    assert.equal(cap.input, undefined);
  });

  it('exposes maxReplans', () => {
    assert.equal(
      new ReviewerErrorStrategy(reviewer({}, { action: 'abort' }), 2)
        .maxReplans,
      2,
    );
  });
});
