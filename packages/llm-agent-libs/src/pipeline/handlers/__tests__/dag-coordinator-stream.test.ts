import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  DagPlan,
  IInterpreter,
  InterpretResult,
  IPlanner,
  ISubAgent,
} from '@mcp-abap-adt/llm-agent';
import { DagCoordinatorHandler } from '../dag-coordinator.js';

test('handler yields content deltas as soon as interpreter/finalizer emit them', async () => {
  const planner: IPlanner = {
    name: 'p',
    async plan() {
      return {
        plan: {
          objective: 'o',
          nodes: [{ id: 'a', goal: 'ga' }],
          createdAt: 0,
        },
      };
    },
  };
  const worker: ISubAgent = {
    name: 'w',
    description: 'd',
    capabilities: { contextPolicy: 'optional' },
    async run() {
      return { output: 'X' };
    },
  };
  const interpreter: IInterpreter<DagPlan, InterpretResult> = {
    name: 'i',
    async interpret(plan, ictx) {
      ictx.onPartial?.({
        kind: 'stepper-spawned',
        source: { stepperId: 'a', name: 'a' },
        goal: 'ga',
      });
      ictx.onPartial?.({ kind: 'content', nodeId: 'a', delta: 'foo' });
      ictx.onPartial?.({ kind: 'content', nodeId: 'a', delta: 'bar' });
      ictx.onPartial?.({
        kind: 'stepper-done',
        source: { stepperId: 'a', name: 'a' },
        ok: true,
      });
      return {
        ok: true,
        nodeResults: {
          a: { nodeId: 'a', output: 'foobar', status: 'done', durationMs: 1 },
        },
        output: 'foobar',
        executedPlan: plan,
        executionOrder: ['a'],
      };
    },
  };
  const yielded: { content?: string; finishReason?: string }[] = [];
  const ctx = {
    inputText: 'do',
    sessionId: 's',
    history: [],
    requestLogger: {
      startRequest() {},
      getSummary() {
        return { byComponent: {}, byModel: {}, byCategory: {} };
      },
      logLlmCall() {},
      logStep() {},
    },
    yield(c: {
      ok?: boolean;
      value?: { content?: string; finishReason?: string };
    }) {
      if (c.value)
        yielded.push({
          content: c.value.content,
          finishReason: c.value.finishReason,
        });
    },
    options: { trace: { traceId: 't1' } },
  } as never;
  const h = new DagCoordinatorHandler({
    planner,
    interpreter,
    workers: new Map([['w', worker]]),
  });
  await h.execute(ctx, {}, {} as never);

  // Content yields:
  //   foo  (worker delta)
  //   bar  (worker delta)
  //   foobar (PassthroughFinalizer one-shot)
  const contentYields = yielded.filter(
    (y) => (y.content ?? '') !== '' && !y.finishReason,
  );
  assert.deepEqual(
    contentYields.map((y) => y.content),
    ['foo', 'bar', 'foobar'],
  );

  // Final stop yield still present (with empty content, finishReason='stop'):
  const stop = yielded.find((y) => y.finishReason === 'stop');
  assert.ok(stop, 'final stop yield must be present');
});
