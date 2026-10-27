import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  beginLlmRequest,
  type ILlm,
  type IMcpClient,
  type IUsageRecorder,
  startOperation,
  ToolCache,
  type UsageContext,
  type UsageInput,
} from '@mcp-abap-adt/llm-agent';
import { SmartAgentBuilder } from '../../../builder.js';
import { SessionRequestLogger } from '../../../logger/session-request-logger.js';
import { NoopMetrics } from '../../../metrics/noop-metrics.js';
import { fireInternalToolsAsync } from '../../../policy/mixed-tool-call-handler.js';
import { PendingToolResultsRegistry } from '../../../policy/pending-tool-results-registry.js';
import { ToolAvailabilityRegistry } from '../../../policy/tool-availability-registry.js';
import { NoopTracer } from '../../../tracer/noop-tracer.js';
import { DefaultPipeline } from '../../default-pipeline.js';
import { runPassThrough } from '../pass-through.js';
import { executeToolBatchWithHeartbeat } from '../tool-loop-core.js';

for (const role of ['planner', undefined]) {
  test(`tool-loop paths preserve role ${role} and record component`, async () => {
    const records: UsageInput[] = [];
    function scoped(context: UsageContext): IUsageRecorder {
      return {
        record(input) {
          records.push({ ...input, context: { ...context, ...input.context } });
        },
        with(extra) {
          return scoped({ ...context, ...extra });
        },
      };
    }
    const base = scoped({});
    const usage = role ? base.with({ role }) : base;
    function record(usage?: IUsageRecorder): void {
      beginLlmRequest({ usage }, startOperation(), {
        provider: 'fake',
        model: 'fake',
        stream: true,
        granularity: 'request',
        retriesVisible: true,
      }).end({ outcome: 'ok' });
    }
    const llm: ILlm = {
      async chat() {
        return { ok: true, value: { content: 'ok', finishReason: 'stop' } };
      },
      async *streamChat(_messages, _tools, opts) {
        record(opts?.usage);
        yield { ok: true, value: { content: 'ok' } };
      },
    };
    for await (const chunk of runPassThrough(
      llm,
      new SessionRequestLogger(),
      [],
      [],
      { usage },
    )) {
      assert.ok(chunk.ok);
    }
    const client: IMcpClient = {
      async listTools() {
        return { ok: true, value: [] };
      },
      async callTool(_name, _args, opts) {
        record(opts?.usage);
        return { ok: true, value: { content: 'ok' } };
      },
    };
    const call = { id: 'c', name: 'tool', arguments: {} };
    const toolCache = new ToolCache();
    const registry = new PendingToolResultsRegistry();
    fireInternalToolsAsync('', [call], registry, 's', {
      toolClientMap: new Map([['tool', client]]),
      toolCache,
      metrics: new NoopMetrics(),
      options: { usage },
    });
    await registry.consume('s');
    const tracer = new NoopTracer();
    const run = executeToolBatchWithHeartbeat({
      batch: [call],
      toolClientMap: new Map([['tool', client]]),
      toolCache,
      tracer,
      metrics: new NoopMetrics(),
      parentSpan: tracer.startSpan('test'),
      toolAvailabilityRegistry: new ToolAvailabilityRegistry(),
      sessionId: 's',
      externalToolNames: new Set(),
      currentTools: [],
      toolCallCount: 0,
      timingLog: [],
      heartbeatMs: null,
      options: { usage },
    });
    let next = await run.next();
    while (!next.done) next = await run.next();
    assert.equal(records.length, 3);
    const handle = await new SmartAgentBuilder({ skipModelValidation: true })
      .withMainLlm(llm)
      .setPipeline(new DefaultPipeline())
      .build();
    try {
      const result = await handle.agent.process('go', { usage });
      assert.ok(result.ok);
    } finally {
      await handle.close();
    }
    assert.equal(records.length, 4);
    for (const entry of records) {
      assert.equal(entry.context.role, role);
      assert.equal(entry.context.component, 'tool-loop');
    }
  });
}
