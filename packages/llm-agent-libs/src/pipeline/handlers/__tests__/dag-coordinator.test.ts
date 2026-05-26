import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  DagPlan,
  IInterpreter,
  InterpretResult,
  IPlanner,
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

  it('maps interpreter ok:false to COORDINATOR_STEP_FAILED', async () => {
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
});
