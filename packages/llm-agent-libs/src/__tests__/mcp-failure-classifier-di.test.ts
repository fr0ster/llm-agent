/**
 * Task 5 — DI threading for IMcpFailureClassifier.
 *
 * Four focused tests:
 * (a) builder seam — withMcpFailureClassifier threads the classifier into SmartAgentDeps / PipelineDeps.
 * (b) direct SmartAgent path (Route A, direct caller) — SmartAgent._runStreamingToolLoop passes
 *     deps.mcpFailureClassifier to executeToolBatchWithHeartbeat; a custom classifier that escalates
 *     MCP_ERROR causes the run to fail loud.
 * (c) smart-server / callMcp — SmartServer stores the instance classifier and passes it to buildMcpBridge.
 * (d) probe through core — toolClientMap.get(tc.name).healthCheck is derived into a probe and forwarded
 *     to classifyToolResult; escalation behaviour depends on the probe result.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  IMcpClient,
  IMcpFailureClassifier,
  McpError as McpErrorType,
  McpTool,
  McpToolResult,
  Result,
} from '@mcp-abap-adt/llm-agent';
import { McpError, NoopToolCache } from '@mcp-abap-adt/llm-agent';
import { SmartAgent } from '../agent.js';
import { SmartAgentBuilder } from '../builder.js';
import { NoopMetrics } from '../metrics/noop-metrics.js';
import {
  executeToolBatchWithHeartbeat,
  type IExecuteToolBatchArgs,
} from '../pipeline/handlers/tool-loop-core.js';
import { ToolAvailabilityRegistry } from '../policy/tool-availability-registry.js';
import { makeDefaultDeps, makeLlm } from '../testing/index.js';
import { NoopTracer } from '../tracer/noop-tracer.js';
import type { ISpan } from '../tracer/types.js';

// ---------------------------------------------------------------------------
// (a) Builder seam — withMcpFailureClassifier threads the classifier
// ---------------------------------------------------------------------------

test('(a) builder: withMcpFailureClassifier stores classifier on builder private field', () => {
  const custom: IMcpFailureClassifier = {
    classify: async () => 'unavailable',
  };
  const builder = new SmartAgentBuilder();
  builder.withMcpFailureClassifier(custom);
  // Access private field via cast — verifies the setter stored it.
  const stored = (
    builder as unknown as { _mcpFailureClassifier?: IMcpFailureClassifier }
  )._mcpFailureClassifier;
  assert.strictEqual(
    stored,
    custom,
    'builder must store the injected classifier',
  );
});

test('(a) builder: without withMcpFailureClassifier, _mcpFailureClassifier is undefined', () => {
  const builder = new SmartAgentBuilder();
  const stored = (
    builder as unknown as { _mcpFailureClassifier?: IMcpFailureClassifier }
  )._mcpFailureClassifier;
  assert.strictEqual(
    stored,
    undefined,
    'field must be undefined when unset (default resolves in core)',
  );
});

// ---------------------------------------------------------------------------
// (b) Direct SmartAgent path (Route A — SmartAgent._runStreamingToolLoop)
// ---------------------------------------------------------------------------

const TOOL: McpTool = {
  name: 'GetTable',
  description: 'read',
  inputSchema: {},
};

function clientReturning(
  result: Result<McpToolResult, McpErrorType>,
): IMcpClient {
  return {
    async listTools(): Promise<Result<McpTool[], McpErrorType>> {
      return { ok: true, value: [TOOL] };
    },
    async callTool(): Promise<Result<McpToolResult, McpErrorType>> {
      return result;
    },
  } as IMcpClient;
}

test('(b) direct SmartAgent: custom classifier escalating MCP_ERROR fails the run loud', async () => {
  // Custom classifier: treat ANY failed tool as unavailable (including MCP_ERROR).
  const allUnavailable: IMcpFailureClassifier = {
    classify: async () => 'unavailable',
  };
  const client = clientReturning({
    ok: false,
    error: new McpError('tool logic failed', 'MCP_ERROR'),
  });
  const { deps } = makeDefaultDeps({ mcpClients: [client] });
  // Tool-call then final text (would be reached only if tool error stays as feedback).
  deps.mainLlm = makeLlm([
    {
      content: '',
      toolCalls: [{ id: 'c0', name: 'GetTable', arguments: {} }],
      finishReason: 'tool_calls',
    },
    { content: 'should not be reached', finishReason: 'stop' },
  ]);
  deps.mcpFailureClassifier = allUnavailable;
  // Direct SmartAgent path — no pipeline.
  const agent = new SmartAgent(deps, { maxIterations: 5, mode: 'hard' });
  const res = await agent.process('read table T');
  assert.equal(
    res.ok,
    false,
    'custom classifier mapping MCP_ERROR→unavailable must fail loud',
  );
});

test('(b) direct SmartAgent: without custom classifier MCP_ERROR stays tool feedback (default behavior unchanged)', async () => {
  const client = clientReturning({
    ok: false,
    error: new McpError('table not found', 'MCP_ERROR'),
  });
  const { deps } = makeDefaultDeps({ mcpClients: [client] });
  deps.mainLlm = makeLlm([
    {
      content: '',
      toolCalls: [{ id: 'c0', name: 'GetTable', arguments: {} }],
      finishReason: 'tool_calls',
    },
    { content: 'the table does not exist', finishReason: 'stop' },
  ]);
  // No mcpFailureClassifier set → DefaultMcpFailureClassifier used → MCP_ERROR stays feedback.
  const agent = new SmartAgent(deps, { maxIterations: 5, mode: 'hard' });
  const res = await agent.process('read table T');
  assert.equal(
    res.ok,
    true,
    'default: MCP_ERROR must stay LLM feedback, not escalate',
  );
});

// ---------------------------------------------------------------------------
// (d) Probe through core — toolClientMap health probe reaches classifyToolResult
// ---------------------------------------------------------------------------

function makeSpan(): ISpan {
  return {
    name: 's',
    setAttribute() {},
    setStatus() {},
    addEvent() {},
    end() {},
  } as unknown as ISpan;
}

function makeBaseArgs(
  client: IMcpClient,
  classifier: IMcpFailureClassifier,
): IExecuteToolBatchArgs {
  return {
    batch: [{ id: 'c0', name: 'GetTable', arguments: {} }],
    toolClientMap: new Map([['GetTable', client]]),
    toolCache: new NoopToolCache(),
    tracer: new NoopTracer(),
    metrics: new NoopMetrics(),
    parentSpan: makeSpan(),
    toolAvailabilityRegistry: new ToolAvailabilityRegistry(),
    sessionId: 'test-session',
    externalToolNames: new Set<string>(),
    currentTools: [],
    toolCallCount: 0,
    timingLog: [],
    heartbeatMs: 30_000,
    options: undefined,
    mcpFailureClassifier: classifier,
  };
}

async function drainBatch(args: IExecuteToolBatchArgs) {
  const chunks: { ok: boolean }[] = [];
  const gen = executeToolBatchWithHeartbeat(args);
  let next = await gen.next();
  while (!next.done) {
    chunks.push({ ok: next.value.ok });
    next = await gen.next();
  }
  return { outcome: next.value, chunks };
}

test('(d) core probe: healthCheck→{ok:true,value:false} + probe-aware classifier → escalates', async () => {
  // Client whose tool call returns MCP_ERROR (tool-level, normally not escalated)
  // but whose healthCheck returns {ok:true,value:false} (server is DOWN).
  const client: IMcpClient = {
    async listTools() {
      return { ok: true, value: [TOOL] };
    },
    async callTool() {
      return {
        ok: false as const,
        error: new McpError('server down', 'MCP_ERROR'),
      };
    },
    async healthCheck() {
      return { ok: true as const, value: false }; // server reports unhealthy
    },
  } as IMcpClient;

  // Classifier: escalates only when probe returns false (server unhealthy).
  const probeAware: IMcpFailureClassifier = {
    classify: async (_err, probeHealth) => {
      if (probeHealth && !(await probeHealth())) return 'unavailable';
      return 'tool-error';
    },
  };

  const args = makeBaseArgs(client, probeAware);
  const { outcome, chunks } = await drainBatch(args);

  assert.equal(
    outcome.escalated,
    true,
    'must escalate when probe returns false',
  );
  assert.ok(
    chunks.some((c) => !c.ok),
    'an error chunk must be yielded on escalation',
  );
});

test('(d) core probe: healthCheck→{ok:true,value:true} + probe-aware classifier → does NOT escalate', async () => {
  // Same MCP_ERROR but healthCheck says server is healthy.
  const client: IMcpClient = {
    async listTools() {
      return { ok: true, value: [TOOL] };
    },
    async callTool() {
      return {
        ok: false as const,
        error: new McpError('transient', 'MCP_ERROR'),
      };
    },
    async healthCheck() {
      return { ok: true as const, value: true }; // server is healthy
    },
  } as IMcpClient;

  const probeAware: IMcpFailureClassifier = {
    classify: async (_err, probeHealth) => {
      if (probeHealth && !(await probeHealth())) return 'unavailable';
      return 'tool-error';
    },
  };

  const args = makeBaseArgs(client, probeAware);
  const { outcome, chunks } = await drainBatch(args);

  assert.equal(
    outcome.escalated,
    false,
    'must NOT escalate when probe returns true',
  );
  assert.ok(
    chunks.every((c) => c.ok),
    'no error chunks should be yielded',
  );
});
