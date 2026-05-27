import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  DagPlan,
  ExecutionReviewDecision,
  IInterpreter,
  InterpretResult,
  IPlanner,
  ISubAgent,
} from '@mcp-abap-adt/llm-agent';
import {
  CLARIFY_MARKER,
  ClarifySignal,
  NeedInfoSignal,
} from '@mcp-abap-adt/llm-agent';
import { DagCoordinatorHandler } from '../dag-coordinator.js';

const planner = (nodes: DagPlan['nodes']): IPlanner => ({
  name: 'p',
  plan: async () => ({ nodes, createdAt: 0 }),
});
const interp = (
  r: InterpretResult,
): IInterpreter<DagPlan, InterpretResult> => ({
  name: 'i',
  interpret: async () => r,
});

function makeCtx(inputText: string) {
  const yields: Array<{
    ok: boolean;
    value: { content: string; finishReason?: string };
  }> = [];
  const ctx = {
    inputText,
    sessionId: 't',
    yield: (c: {
      ok: boolean;
      value: { content: string; finishReason?: string };
    }) => yields.push(c),
  } as unknown as Parameters<DagCoordinatorHandler['execute']>[0];
  return { ctx, yields };
}

/** Stub oracle: always returns 'oracle X' */
const stubOracle = {
  name: 'o',
  capabilities: { contextPolicy: 'optional' as const },
  run: async () => ({ output: 'oracle X' }),
} as unknown as ISubAgent;

describe('DagCoordinatorHandler', () => {
  it('plans then interprets and streams the output raw', async () => {
    const { ctx, yields } = makeCtx('hi');
    const h = new DagCoordinatorHandler({
      planner: planner([{ id: 'n1', goal: 'g' }]),
      interpreter: interp({ nodeResults: {}, ok: true, output: '42' }),
      workers: new Map(),
    });
    const ok = await h.execute(ctx, {}, {} as never);
    assert.equal(ok, true);
    assert.equal(yields[0].value.content, '42');
    assert.equal(yields[1].value.finishReason, 'stop');
  });

  it('maps interpreter ok:false to COORDINATOR_STEP_FAILED (no reviewer)', async () => {
    const { ctx, yields } = makeCtx('hi');
    const h = new DagCoordinatorHandler({
      planner: planner([{ id: 'n1', goal: 'g' }]),
      interpreter: interp({
        nodeResults: {},
        ok: false,
        error: 'boom',
        output: '',
      }),
      workers: new Map(),
    });
    const ok = await h.execute(ctx, {}, {} as never);
    assert.equal(ok, false);
    assert.equal(
      (ctx as unknown as { error?: { code?: string } }).error?.code,
      'COORDINATOR_STEP_FAILED',
    );
    assert.equal(yields.length, 0);
  });

  it('maps a planner throw to COORDINATOR_PLAN_FAILED', async () => {
    const { ctx, yields } = makeCtx('hi');
    const h = new DagCoordinatorHandler({
      planner: {
        name: 'p',
        plan: async () => {
          throw new Error('nope');
        },
      },
      interpreter: interp({ nodeResults: {}, ok: true, output: 'x' }),
      workers: new Map(),
    });
    const ok = await h.execute(ctx, {}, {} as never);
    assert.equal(ok, false);
    assert.equal(
      (ctx as unknown as { error?: { code?: string } }).error?.code,
      'COORDINATOR_PLAN_FAILED',
    );
    assert.equal(yields.length, 0);
  });

  it('preserves COORDINATOR_PLAN_INVALID from an interpreter throw', async () => {
    const { ctx } = makeCtx('hi');
    const throwingInterp = {
      name: 'i',
      interpret: async () => {
        const e = Object.assign(new Error('bad plan'), {
          code: 'COORDINATOR_PLAN_INVALID',
        });
        throw e;
      },
    } as unknown as IInterpreter<DagPlan, InterpretResult>;
    const h = new DagCoordinatorHandler({
      planner: planner([{ id: 'n1', goal: 'g' }]),
      interpreter: throwingInterp,
      workers: new Map(),
    });
    const ok = await h.execute(ctx, {}, {} as never);
    assert.equal(ok, false);
    assert.equal(
      (ctx as unknown as { error?: { code?: string } }).error?.code,
      'COORDINATOR_PLAN_INVALID',
    );
  });

  it('passes through to interpret when the reviewer passes', async () => {
    const { ctx, yields } = makeCtx('hi');
    const h = new DagCoordinatorHandler({
      planner: planner([{ id: 'n1', goal: 'g' }]),
      interpreter: interp({ nodeResults: {}, ok: true, output: '42' }),
      workers: new Map(),
      reviewer: { name: 'r', review: async () => ({ pass: true }) },
    });
    const ok = await h.execute(ctx, {}, {} as never);
    assert.equal(ok, true);
    assert.equal(yields[0].value.content, '42');
  });

  it('gate reject → replan → pass → done', async () => {
    const { ctx, yields } = makeCtx('hi');
    let reviewCalls = 0;
    let planBUsed = false;
    const planA: DagPlan = {
      nodes: [{ id: 'a1', goal: 'original' }],
      createdAt: 0,
    };
    const planB: DagPlan = {
      nodes: [{ id: 'b1', goal: 'revised' }],
      createdAt: 0,
    };

    const h = new DagCoordinatorHandler({
      planner: {
        name: 'p',
        plan: async (input) => {
          if (input.reviewerFeedback) {
            planBUsed = true;
            return planB;
          }
          return planA;
        },
      },
      interpreter: interp({ nodeResults: {}, ok: true, output: 'done' }),
      workers: new Map(),
      reviewer: {
        name: 'r',
        review: async () => {
          reviewCalls++;
          if (reviewCalls === 1) return { pass: false, feedback: 'bad' };
          return { pass: true };
        },
      },
    });
    const ok = await h.execute(ctx, {}, {} as never);
    assert.equal(ok, true);
    assert.equal(planBUsed, true, 'should have replanned with feedback');
    assert.equal(yields[0].value.content, 'done');
  });

  it('maps a reviewer throw to COORDINATOR_STEP_FAILED (via outer catch)', async () => {
    const { ctx } = makeCtx('hi');
    const h = new DagCoordinatorHandler({
      planner: planner([{ id: 'n1', goal: 'g' }]),
      interpreter: interp({ nodeResults: {}, ok: true, output: 'x' }),
      workers: new Map(),
      reviewer: {
        name: 'r',
        review: async () => {
          throw new Error('critic boom');
        },
      },
    });
    const ok = await h.execute(ctx, {}, {} as never);
    assert.equal(ok, false);
    // Reviewer throws are caught by the outer try/catch → COORDINATOR_STEP_FAILED
    const code = (ctx as unknown as { error?: { code?: string } }).error?.code;
    assert.ok(
      code === 'COORDINATOR_STEP_FAILED' ||
        code === 'COORDINATOR_REVIEW_FAILED',
      `unexpected code: ${code}`,
    );
  });

  it("rejects a worker with contextPolicy='required' at construction", () => {
    const worker = (policy: 'required' | 'optional') =>
      ({
        name: 'w',
        capabilities: { contextPolicy: policy },
        run: async () => ({ output: '' }),
      }) as unknown as import('@mcp-abap-adt/llm-agent').ISubAgent;
    assert.throws(
      () =>
        new DagCoordinatorHandler({
          planner: planner([{ id: 'n1', goal: 'g' }]),
          interpreter: interp({ nodeResults: {}, ok: true, output: 'x' }),
          workers: new Map([['w', worker('required')]]),
        }),
      /contextPolicy='required'/,
    );
    assert.doesNotThrow(
      () =>
        new DagCoordinatorHandler({
          planner: planner([{ id: 'n1', goal: 'g' }]),
          interpreter: interp({ nodeResults: {}, ok: true, output: 'x' }),
          workers: new Map([['w', worker('optional')]]),
        }),
    );
  });

  // ── Slice 4b: reviewer recovery ────────────────────────────────────────────

  it('reviewExecutionFailure revise → re-interpret → done', async () => {
    const { ctx, yields } = makeCtx('hi');
    let interpCalls = 0;
    const failResult: InterpretResult = {
      ok: false,
      failedNodeId: 'n1',
      executedPlan: { nodes: [{ id: 'n1', goal: 'g' }], createdAt: 0 },
      nodeResults: {
        n1: {
          nodeId: 'n1',
          status: 'failed',
          error: 'e',
          output: '',
          durationMs: 0,
        },
      },
      error: 'e',
      output: '',
    };
    const h = new DagCoordinatorHandler({
      planner: planner([{ id: 'n1', goal: 'g' }]),
      interpreter: {
        name: 'i',
        interpret: async () => {
          interpCalls++;
          if (interpCalls === 1) return failResult;
          return { nodeResults: {}, ok: true, output: 'fixed' };
        },
      },
      workers: new Map(),
      reviewer: {
        name: 'r',
        review: async () => ({ pass: true }),
        reviewExecutionFailure: async (): Promise<ExecutionReviewDecision> => ({
          action: 'revise',
          revisedPlan: { nodes: [{ id: 'r1', goal: 'fix' }], createdAt: 0 },
        }),
      },
    });
    const ok = await h.execute(ctx, {}, {} as never);
    assert.equal(ok, true);
    assert.equal(interpCalls, 2);
    assert.equal(yields[0].value.content, 'fixed');
    assert.equal(yields[1].value.finishReason, 'stop');
  });

  it('clarify from reviewExecutionFailure → turn ends', async () => {
    const { ctx, yields } = makeCtx('hi');
    const h = new DagCoordinatorHandler({
      planner: planner([{ id: 'n1', goal: 'g' }]),
      interpreter: interp({
        ok: false,
        error: 'e',
        output: '',
        nodeResults: {},
      }),
      workers: new Map(),
      reviewer: {
        name: 'r',
        review: async () => ({ pass: true }),
        reviewExecutionFailure: async () => {
          throw new ClarifySignal('q');
        },
      },
    });
    const ok = await h.execute(ctx, {}, {} as never);
    assert.equal(ok, true);
    assert.equal((ctx as unknown as { error?: unknown }).error, undefined);
    assert.ok(yields.length >= 2);
    assert.equal(yields[0].value.content, CLARIFY_MARKER + 'q');
    assert.equal(yields[1].value.finishReason, 'stop');
  });

  it('needInfo with oracle → round-trip → completes', async () => {
    const { ctx, yields } = makeCtx('hi');
    let oracleCalls = 0;
    let failureReviewCalls = 0;
    const oracle: ISubAgent = {
      ...stubOracle,
      run: async () => {
        oracleCalls++;
        return { output: 'oracle X' };
      },
    } as unknown as ISubAgent;

    const h = new DagCoordinatorHandler({
      planner: planner([{ id: 'n1', goal: 'g' }]),
      interpreter: {
        name: 'i',
        interpret: async () => {
          if (failureReviewCalls === 0) {
            return { ok: false, error: 'e', output: '', nodeResults: {} };
          }
          return { ok: true, output: 'done', nodeResults: {} };
        },
      },
      workers: new Map(),
      reviewer: {
        name: 'r',
        review: async () => ({ pass: true }),
        reviewExecutionFailure: async (): Promise<ExecutionReviewDecision> => {
          failureReviewCalls++;
          if (failureReviewCalls === 1) {
            throw new NeedInfoSignal('q');
          }
          return {
            action: 'revise',
            revisedPlan: { nodes: [{ id: 'r1', goal: 'fix' }], createdAt: 0 },
          };
        },
      },
      stateOracle: oracle,
    });
    const ok = await h.execute(ctx, {}, {} as never);
    assert.equal(ok, true);
    assert.equal(oracleCalls, 1, 'oracle should be called once');
    assert.equal(yields[0].value.content, 'done');
  });

  it('needInfo with no oracle → COORDINATOR_NEEDINFO_UNRESOLVED, returns false', async () => {
    const { ctx } = makeCtx('hi');
    const h = new DagCoordinatorHandler({
      planner: planner([{ id: 'n1', goal: 'g' }]),
      interpreter: interp({
        ok: false,
        error: 'e',
        output: '',
        nodeResults: {},
      }),
      workers: new Map(),
      reviewer: {
        name: 'r',
        review: async () => ({ pass: true }),
        reviewExecutionFailure: async () => {
          throw new NeedInfoSignal('q');
        },
      },
      // no stateOracle
    });
    const ok = await h.execute(ctx, {}, {} as never);
    assert.equal(ok, false);
    assert.equal(
      (ctx as unknown as { error?: { code?: string } }).error?.code,
      'COORDINATOR_NEEDINFO_UNRESOLVED',
    );
  });

  it('budget exhausted → COORDINATOR_BUDGET_EXHAUSTED', async () => {
    const { ctx } = makeCtx('hi');
    const h = new DagCoordinatorHandler({
      planner: planner([{ id: 'n1', goal: 'g' }]),
      interpreter: interp({
        ok: false,
        error: 'e',
        output: '',
        nodeResults: {},
      }),
      workers: new Map(),
      reviewer: {
        name: 'r',
        review: async () => ({ pass: true }),
        reviewExecutionFailure: async (): Promise<ExecutionReviewDecision> => ({
          action: 'revise',
          revisedPlan: { nodes: [{ id: 'r1', goal: 'fix' }], createdAt: 0 },
        }),
      },
      maxRoundTrips: 3,
    });
    const ok = await h.execute(ctx, {}, {} as never);
    assert.equal(ok, false);
    assert.equal(
      (ctx as unknown as { error?: { code?: string } }).error?.code,
      'COORDINATOR_BUDGET_EXHAUSTED',
    );
  });
});
