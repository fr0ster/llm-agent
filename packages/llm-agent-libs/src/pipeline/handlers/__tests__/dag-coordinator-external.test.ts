import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  DagPlan,
  IFinalizer,
  IInterpreter,
  InterpretResult,
  IPlanner,
  ISubAgent,
  LlmToolCall,
} from '@mcp-abap-adt/llm-agent';
import { SessionRequestLogger } from '../../../logger/session-request-logger.js';
import { DagCoordinatorHandler } from '../dag-coordinator.js';

function plan(): DagPlan {
  return {
    objective: 'plan-obj',
    nodes: [{ id: 'a', goal: 'ga' }],
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
  async run() {
    return { output: 'unused' };
  },
};

function makeCtx() {
  const yields: Array<{ ok: boolean; value: Record<string, unknown> }> = [];
  const logger = new SessionRequestLogger();
  logger.startRequest('t1');
  return {
    yields,
    ctx: {
      inputText: 'do thing',
      sessionId: 's1',
      history: [],
      requestLogger: logger,
      yield(chunk: { ok: boolean; value: Record<string, unknown> }) {
        yields.push(chunk);
      },
      options: { trace: { traceId: 't1' } },
    } as never,
  };
}

function pendingInterpreter(
  pending: LlmToolCall[],
): IInterpreter<DagPlan, InterpretResult> {
  return {
    name: 'i',
    async interpret(p) {
      return {
        ok: true,
        nodeResults: {
          a: {
            nodeId: 'a',
            output: '',
            status: 'awaiting-external',
            durationMs: 1,
          },
        },
        output: '',
        executedPlan: p,
        executionOrder: ['a'],
        pendingExternalToolCalls: pending,
      };
    },
  };
}

const completeInterpreter: IInterpreter<DagPlan, InterpretResult> = {
  name: 'i',
  async interpret(p) {
    return {
      ok: true,
      nodeResults: {
        a: { nodeId: 'a', output: 'A-OUT', status: 'done', durationMs: 1 },
      },
      output: 'A-OUT',
      executedPlan: p,
      executionOrder: ['a'],
    };
  },
};

test('no-finalizer branch: pending external tool calls yield a tool_calls turn and SKIP the finalizer', async () => {
  let finalizeCalls = 0;
  const finalizer: IFinalizer = {
    name: 'spy',
    async finalize() {
      finalizeCalls++;
      return { output: 'SHOULD-NOT-RUN' };
    },
  };
  const pending: LlmToolCall[] = [
    { id: 'ext:abc123', name: 'rag_add', arguments: { content: 'hi' } },
  ];
  const h = new DagCoordinatorHandler({
    planner,
    interpreter: pendingInterpreter(pending),
    workers: new Map([['w', worker]]),
    finalizer,
  });
  const { ctx, yields } = makeCtx();
  await h.execute(ctx, {}, {} as never);

  assert.equal(finalizeCalls, 0, 'finalizer must NOT be invoked');

  // First the tool_calls chunk carrying the external call (wire delta shape).
  const tcYield = yields.find(
    (y) => Array.isArray(y.value.toolCalls) && y.value.toolCalls.length > 0,
  );
  assert.ok(tcYield, 'expected a chunk carrying toolCalls');
  const tc = (
    tcYield.value.toolCalls as Array<{
      index: number;
      id: string;
      name: string;
      arguments: string;
    }>
  )[0];
  assert.equal(tc.id, 'ext:abc123');
  assert.equal(tc.name, 'rag_add');
  assert.equal(tc.arguments, JSON.stringify({ content: 'hi' }));

  // Then the terminal tool_calls finishReason chunk.
  const terminal = yields.find((y) => y.value.finishReason === 'tool_calls');
  assert.ok(terminal, 'expected terminal finishReason=tool_calls chunk');
});

test('regression #171: two pending external calls get distinct indices [0,1], not [0,0]', async () => {
  const pending: LlmToolCall[] = [
    { id: 'ext:aaa111', name: 'rag_add', arguments: { a: 1 } },
    { id: 'ext:bbb222', name: 'rag_add', arguments: { b: 2 } },
  ];
  const h = new DagCoordinatorHandler({
    planner,
    interpreter: pendingInterpreter(pending),
    workers: new Map([['w', worker]]),
  });
  const { ctx, yields } = makeCtx();
  await h.execute(ctx, {}, {} as never);

  // Find the toolCalls chunk.
  const tcYield = yields.find(
    (y) =>
      Array.isArray(y.value.toolCalls) &&
      (y.value.toolCalls as unknown[]).length > 0,
  );
  assert.ok(tcYield, 'expected a chunk carrying toolCalls');

  const calls = tcYield.value.toolCalls as Array<{
    index: number;
    id: string;
    name: string;
    arguments: string;
  }>;
  assert.equal(calls.length, 2, 'both external calls must be surfaced');

  // Regression: with the old bug both entries had index 0 (all-0). Now they
  // must be mapped by array position.
  const indices = calls.map((c) => c.index);
  assert.deepEqual(
    indices,
    [0, 1],
    `expected distinct indices [0,1], got ${JSON.stringify(indices)}`,
  );

  const ids = calls.map((c) => c.id);
  assert.deepEqual(
    ids,
    ['ext:aaa111', 'ext:bbb222'],
    `expected ids in order, got ${JSON.stringify(ids)}`,
  );

  // Arguments serialised correctly.
  assert.equal(calls[0].arguments, JSON.stringify({ a: 1 }));
  assert.equal(calls[1].arguments, JSON.stringify({ b: 2 }));

  // Terminal chunk present.
  const terminal = yields.find((y) => y.value.finishReason === 'tool_calls');
  assert.ok(terminal, 'expected terminal finishReason=tool_calls chunk');
});

test('no-finalizer branch: empty pending → finalizer IS invoked (existing path)', async () => {
  let finalizeCalls = 0;
  const finalizer: IFinalizer = {
    name: 'spy',
    async finalize(input) {
      finalizeCalls++;
      input.onPartial?.({ kind: 'content', delta: 'FINAL' });
      return { output: 'FINAL' };
    },
  };
  const h = new DagCoordinatorHandler({
    planner,
    interpreter: completeInterpreter,
    workers: new Map([['w', worker]]),
    finalizer,
  });
  const { ctx, yields } = makeCtx();
  await h.execute(ctx, {}, {} as never);

  assert.equal(
    finalizeCalls,
    1,
    'finalizer must be invoked on the normal path',
  );
  const contentYield = yields.find(
    (y) => y.value.content && y.value.finishReason !== 'stop',
  );
  assert.equal(contentYield?.value.content, 'FINAL');
});
