/**
 * The heartbeat tick timer raced against a tool batch must never outlive the
 * race: after a fast batch, a failing batch, or a tick that fired, no timer
 * scheduled by `executeToolBatchWithHeartbeat` may stay pending (a pending
 * timer keeps the process alive after every tool batch).
 */
import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import type {
  IMcpClient,
  McpError as McpErrorType,
  McpToolResult,
  Result,
} from '@mcp-abap-adt/llm-agent';
import { McpError, NoopToolCache } from '@mcp-abap-adt/llm-agent';
import { NoopMetrics } from '../../../metrics/noop-metrics.js';
import { ToolAvailabilityRegistry } from '../../../policy/tool-availability-registry.js';
import { NoopTracer } from '../../../tracer/noop-tracer.js';
import type { ISpan } from '../../../tracer/types.js';
import {
  executeToolBatchWithHeartbeat,
  type IExecuteToolBatchArgs,
} from '../tool-loop-core.js';

function clock(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const scheduled = t.mock.method(globalThis, 'setTimeout');
  const cleared = t.mock.method(globalThis, 'clearTimeout');
  return {
    assertCleared() {
      for (const call of scheduled.mock.calls) {
        assert.ok(
          cleared.mock.calls.some(
            (clear) => clear.arguments[0] === call.result,
          ),
        );
      }
    },
    assertScheduled() {
      assert.equal(scheduled.mock.callCount(), 1);
    },
  };
}

const span = {
  name: 's',
  setAttribute() {},
  setStatus() {},
  addEvent() {},
  end() {},
} as unknown as ISpan;

function args(
  callTool: () => Promise<Result<McpToolResult, McpErrorType>>,
  heartbeatMs: number | null = 60_000,
): IExecuteToolBatchArgs {
  const client = {
    async listTools() {
      return { ok: true as const, value: [] };
    },
    callTool,
  } as unknown as IMcpClient;
  return {
    batch: [{ id: 'c0', name: 'T', arguments: {} }],
    toolClientMap: new Map([['T', client]]),
    toolCache: new NoopToolCache(),
    tracer: new NoopTracer(),
    metrics: new NoopMetrics(),
    parentSpan: span,
    toolAvailabilityRegistry: new ToolAvailabilityRegistry(),
    sessionId: 's',
    externalToolNames: new Set<string>(),
    currentTools: [],
    toolCallCount: 0,
    timingLog: [],
    heartbeatMs,
    options: undefined,
  };
}

async function drain(a: IExecuteToolBatchArgs) {
  const chunks: unknown[] = [];
  const gen = executeToolBatchWithHeartbeat(a);
  let n = await gen.next();
  while (!n.done) {
    chunks.push(n.value);
    n = await gen.next();
  }
  return chunks;
}

test('no timer remains after a fast batch', async (t) => {
  const timers = clock(t);
  await drain(
    args(async () => ({ ok: true, value: { content: 'ok' } as McpToolResult })),
  );
  timers.assertCleared();
});

test('no timer remains after a batch whose tool returns an error result', async (t) => {
  const timers = clock(t);
  await drain(
    args(async () => ({ ok: false, error: new McpError('boom', 'MCP_ERROR') })),
  );
  timers.assertCleared();
});

test('no timer remains after a thrown tool error rejects the batch', async (t) => {
  const timers = clock(t);
  const failure = new McpError('rejected', 'MCP_NOT_CONNECTED');
  let recorded = false;
  await assert.rejects(
    () =>
      drain({
        ...args(async () => {
          throw failure;
        }),
        onBatchComplete: async () => {
          recorded = true;
        },
      }),
    (error) => error === failure,
  );
  assert.equal(recorded, false);
  timers.assertCleared();
});

test('heartbeat fires while the tool is pending, and its timer is cleared', async (t) => {
  const timers = clock(t);
  let finishTool = (_result: Result<McpToolResult, McpErrorType>) => {};
  const pending = new Promise<Result<McpToolResult, McpErrorType>>(
    (resolve) => {
      finishTool = resolve;
    },
  );
  const gen = executeToolBatchWithHeartbeat(args(() => pending, 10));
  const first = gen.next();
  timers.assertScheduled();
  t.mock.timers.tick(10);
  const heartbeat = await first;
  assert.ok(!heartbeat.done && heartbeat.value.ok);
  if (!heartbeat.done && heartbeat.value.ok) {
    assert.equal(heartbeat.value.value.heartbeat?.tool, 'T');
  }
  timers.assertCleared();
  finishTool({ ok: true, value: { content: 'ok' } });
  assert.equal((await gen.next()).done, true);
  timers.assertCleared();
});
