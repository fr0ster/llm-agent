/**
 * The heartbeat tick timer raced against a tool batch must never outlive the
 * race: after a fast batch, a failing batch, or a tick that fired, no timer
 * scheduled by `executeToolBatchWithHeartbeat` may stay pending (a pending
 * timer keeps the process alive after every tool batch).
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
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

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
let live: Set<unknown>;

beforeEach(() => {
  live = new Set();
  globalThis.setTimeout = ((fn: () => void, ms?: number, ...a: unknown[]) => {
    const h = realSetTimeout(
      () => {
        live.delete(h);
        fn();
      },
      ms,
      ...a,
    );
    live.add(h);
    return h;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((h: Parameters<typeof clearTimeout>[0]) => {
    live.delete(h);
    realClearTimeout(h);
  }) as typeof clearTimeout;
});

afterEach(() => {
  for (const h of live) realClearTimeout(h as never);
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
});

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

test('no timer remains after a fast batch', async () => {
  await drain(
    args(async () => ({ ok: true, value: { content: 'ok' } as McpToolResult })),
  );
  assert.equal(live.size, 0);
});

test('no timer remains after a batch whose tool returns an error result', async () => {
  await drain(
    args(async () => ({ ok: false, error: new McpError('boom', 'MCP_ERROR') })),
  );
  assert.equal(live.size, 0);
});

test('no timer remains when the batch promise rejects', async () => {
  await assert.rejects(
    drain(
      args(async () => {
        throw new Error('rejected');
      }),
    ),
    /rejected/,
  );
  assert.equal(live.size, 0);
});

test('heartbeat still fires for a slow batch, and no timer remains afterwards', async () => {
  const chunks = await drain(
    args(
      () =>
        new Promise((resolve) =>
          realSetTimeout(
            () =>
              resolve({ ok: true, value: { content: 'ok' } as McpToolResult }),
            60,
          ),
        ),
      10,
    ),
  );
  assert.ok(
    chunks.some(
      (c) => (c as { value?: { heartbeat?: unknown } }).value?.heartbeat,
    ),
    'heartbeat semantics unchanged',
  );
  assert.equal(live.size, 0);
});
