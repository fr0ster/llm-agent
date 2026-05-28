import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  DagPlan,
  IFinalizer,
  IInterpreter,
  InterpretResult,
  IPlanner,
  IStateOracle,
  ISubAgent,
} from '@mcp-abap-adt/llm-agent';
import { NeedInfoSignal } from '@mcp-abap-adt/llm-agent';
import { SessionRequestLogger } from '../../../logger/session-request-logger.js';
import { DagCoordinatorHandler } from '../dag-coordinator.js';

function plan(): DagPlan {
  return {
    objective: 'plan-obj',
    nodes: [
      { id: 'a', goal: 'ga' },
      { id: 'b', goal: 'gb', dependsOn: ['a'] },
    ],
    createdAt: 0,
  };
}

const planner: IPlanner = {
  name: 'p',
  async plan() {
    return { plan: plan() };
  },
};

const worker: ISubAgent = {
  name: 'w',
  description: 'd',
  capabilities: { contextPolicy: 'optional' },
  async run(input) {
    return { output: `OUT(${input.task.slice(0, 4)})` };
  },
};

const interpreter: IInterpreter<DagPlan, InterpretResult> = {
  name: 'i',
  async interpret(p) {
    return {
      ok: true,
      nodeResults: {
        a: { nodeId: 'a', output: 'A-OUT', status: 'done', durationMs: 1 },
        b: { nodeId: 'b', output: 'B-OUT', status: 'done', durationMs: 1 },
      },
      output: 'A-OUT\n\nB-OUT',
      executedPlan: p,
      executionOrder: ['a', 'b'],
    };
  },
};

function makeCtx() {
  const yields: any[] = [];
  const logger = new SessionRequestLogger();
  logger.startRequest('t1');
  return {
    yields,
    ctx: {
      inputText: 'do thing',
      sessionId: 's1',
      history: [],
      requestLogger: logger,
      yield(chunk: unknown) {
        yields.push(chunk);
      },
      options: { trace: { traceId: 't1' } },
    } as never,
  };
}

test('handler invokes finalizer with executionOrder-derived trace and yields finalizer output', async () => {
  let captured: { prompt?: string; trace?: unknown; objective?: string } = {};
  const finalizer: IFinalizer = {
    name: 'capture',
    async finalize(input) {
      captured = {
        prompt: input.prompt,
        trace: input.executionTrace,
        objective: input.objective,
      };
      return {
        output: 'FINAL',
        usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
      };
    },
  };
  const h = new DagCoordinatorHandler({
    planner,
    interpreter,
    workers: new Map([['w', worker]]),
    finalizer,
  });
  const { ctx, yields } = makeCtx();
  await h.execute(ctx, {}, {} as never);
  assert.equal(captured.prompt, 'do thing');
  assert.equal(captured.objective, 'plan-obj');
  assert.deepEqual(captured.trace, [
    { nodeId: 'a', goal: 'ga', output: 'A-OUT' },
    { nodeId: 'b', goal: 'gb', output: 'B-OUT' },
  ]);
  const contentYield = yields.find(
    (y) => y.value?.content && y.value.finishReason !== 'stop',
  );
  assert.equal(contentYield.value.content, 'FINAL');
});

test('handler defaults to PassthroughFinalizer when deps.finalizer is omitted', async () => {
  const h = new DagCoordinatorHandler({
    planner,
    interpreter,
    workers: new Map([['w', worker]]),
  });
  const { ctx, yields } = makeCtx();
  await h.execute(ctx, {}, {} as never);
  const contentYield = yields.find(
    (y) => y.value?.content && y.value.finishReason !== 'stop',
  );
  assert.equal(contentYield.value.content, 'A-OUT\n\nB-OUT');
});
