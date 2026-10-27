import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  IMcpClient,
  IUsageRecorder,
  UsageInput,
} from '@mcp-abap-adt/llm-agent';
import { ToolCache } from '@mcp-abap-adt/llm-agent';
import { NoopMetrics } from '../../../metrics/noop-metrics.js';
import { ToolAvailabilityRegistry } from '../../../policy/tool-availability-registry.js';
import { NoopTracer } from '../../../tracer/noop-tracer.js';
import { executeToolBatchWithHeartbeat } from '../tool-loop-core.js';

for (const isError of [false, true]) {
  test(`cache hit records no dispatch, tool error=${isError}`, async () => {
    const records: UsageInput[] = [];
    const usage: IUsageRecorder = {
      record: (r) => {
        records.push(r);
      },
      with: (context) => {
        assert.equal(context.role, undefined);
        assert.equal(context.component, 'tool-loop');
        return usage;
      },
    };
    const tc = {
      id: 'c1',
      name: 'Read',
      arguments: { private: 'SECRET_ARGUMENT' },
    };
    const toolCache = new ToolCache();
    toolCache.set(tc.name, tc.arguments, { content: 'SECRET_RESULT', isError });
    const client: IMcpClient = {
      listTools: async () => ({ ok: true, value: [] }),
      callTool: async () => {
        assert.fail('cache hit must not dispatch');
      },
    };
    const tracer = new NoopTracer();
    const run = executeToolBatchWithHeartbeat({
      batch: [tc],
      toolClientMap: new Map([[tc.name, client]]),
      toolCache,
      tracer,
      metrics: new NoopMetrics(),
      parentSpan: tracer.startSpan('test'),
      toolAvailabilityRegistry: new ToolAvailabilityRegistry(),
      sessionId: 'session',
      externalToolNames: new Set(),
      currentTools: [],
      toolCallCount: 0,
      timingLog: [],
      heartbeatMs: null,
      options: { usage },
    });
    const result = await run.next();
    assert.equal(result.done, true);
    assert.equal(records.length, 1);
    const r = records[0];
    assert.equal(r.kind, 'tool.call');
    if (r.kind !== 'tool.call') return;
    assert.equal(r.dispatched, false);
    assert.equal(r.transportOutcome, 'ok');
    assert.equal(r.toolOutcome, isError ? 'error' : 'ok');
    assert.equal(r.outcome, isError ? 'error' : 'ok');
    assert.doesNotMatch(JSON.stringify(records), /SECRET/);
  });
}
