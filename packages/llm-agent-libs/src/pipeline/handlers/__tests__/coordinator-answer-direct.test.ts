import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  IDispatchStrategy,
  IPlanningStrategy,
  Plan,
  PlanStep,
  StepResult,
} from '@mcp-abap-adt/llm-agent';
import { CoordinatorHandler } from '../coordinator.js';

function emptyPlanPlanning(
  source: Plan['source'],
  objective?: string,
): IPlanningStrategy {
  return {
    name: 'empty',
    buildInitialPlan: async (): Promise<Plan> => ({
      steps: [],
      objective,
      createdAt: 0,
      source,
    }),
    shouldReplan: () => false,
    rebuildPlan: async () => ({ steps: [], createdAt: 0, source }),
  };
}

function capturingDispatch(result: StepResult): {
  strategy: IDispatchStrategy;
  calls: Array<{ step: PlanStep; objective: string | undefined }>;
} {
  const calls: Array<{ step: PlanStep; objective: string | undefined }> = [];
  return {
    calls,
    strategy: {
      name: 'capture',
      dispatch: async (step: PlanStep, ctx: { plan?: Plan }) => {
        calls.push({ step, objective: ctx.plan?.objective });
        return result;
      },
    },
  };
}

function makeCtx(inputText: string) {
  const yields: Array<{
    ok: boolean;
    value: { content: string; finishReason?: string };
  }> = [];
  const logged: Array<{ step: string; payload: Record<string, unknown> }> = [];
  const ctx = {
    inputText,
    sessionId: 't',
    options: {
      sessionLogger: {
        logStep: (step: string, payload: Record<string, unknown>) => {
          logged.push({ step, payload });
        },
      },
    },
    yield: (c: {
      ok: boolean;
      value: { content: string; finishReason?: string };
    }) => {
      yields.push(c);
    },
  } as unknown as Parameters<CoordinatorHandler['execute']>[0];
  return { ctx, yields, logged };
}

describe('CoordinatorHandler answer-directly', () => {
  it('self-dispatches the original request and streams the answer raw', async () => {
    const { ctx, yields, logged } = makeCtx('What is 17 + 25?');
    const dispatch = capturingDispatch({
      stepId: 'direct-1',
      output: '42',
      ok: true,
      durationMs: 1,
    });
    const handler = new CoordinatorHandler({
      planning: emptyPlanPlanning('planner-llm', 'Some objective'),
      dispatch: dispatch.strategy,
      maxSteps: 10,
      maxRetriesPerStep: 0,
      failPolicy: 'abort',
    });

    const ok = await handler.execute(ctx, {}, {} as never);

    assert.equal(ok, true);
    assert.equal(dispatch.calls.length, 1);
    assert.equal(dispatch.calls[0].step.id, 'direct-1');
    assert.equal(dispatch.calls[0].step.goal, 'What is 17 + 25?');
    assert.equal(dispatch.calls[0].step.status, 'pending');
    assert.equal(dispatch.calls[0].objective, undefined);
    assert.equal(yields[0].value.content, '42');
    assert.equal(yields[1].value.finishReason, 'stop');

    const direct = logged.find((l) => l.step === 'coordinator_answer_direct');
    assert.ok(direct, 'expected a coordinator_answer_direct log entry');
    assert.deepEqual(Object.keys(direct.payload).sort(), [
      'outputLength',
      'stepId',
    ]);
    assert.equal(direct.payload.stepId, 'direct-1');
    assert.equal(direct.payload.outputLength, 2); // '42'.length
  });

  it('surfaces COORDINATOR_STEP_FAILED when the direct dispatch fails', async () => {
    const { ctx } = makeCtx('hi');
    const dispatch = capturingDispatch({
      stepId: 'direct-1',
      output: '',
      ok: false,
      durationMs: 1,
      error: 'no agent and no fallback',
    });
    const handler = new CoordinatorHandler({
      planning: emptyPlanPlanning('planner-llm'),
      dispatch: dispatch.strategy,
      maxSteps: 10,
      maxRetriesPerStep: 0,
      failPolicy: 'abort',
    });

    const ok = await handler.execute(ctx, {}, {} as never);
    assert.equal(ok, false);
    assert.equal(
      (ctx as unknown as { error?: { code?: string } }).error?.code,
      'COORDINATOR_STEP_FAILED',
    );
  });

  it('does NOT answer-directly for a non-planner-llm empty plan', async () => {
    const { ctx } = makeCtx('hi');
    const dispatch = capturingDispatch({
      stepId: 'x',
      output: 'should not run',
      ok: true,
      durationMs: 1,
    });
    const handler = new CoordinatorHandler({
      planning: emptyPlanPlanning('manual'),
      dispatch: dispatch.strategy,
      maxSteps: 10,
      maxRetriesPerStep: 0,
      failPolicy: 'abort',
    });

    await handler.execute(ctx, {}, {} as never);
    assert.equal(dispatch.calls.length, 0);
  });
});
