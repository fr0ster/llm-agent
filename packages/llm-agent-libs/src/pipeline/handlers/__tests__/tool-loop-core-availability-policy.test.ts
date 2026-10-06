/**
 * Spec §10.5.12 U8, §13 B15: the tool availability blacklist is an injected
 * `IToolAvailabilityPolicy`. With none injected a failed tool is never blocked
 * and the tool set is never filtered by it — the error reaches the LLM as the
 * tool result. `HeuristicToolAvailabilityPolicy` keeps 30.1.0's blacklist.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  CallOptions,
  ILlm,
  IMcpClient,
  LlmError,
  LlmResponse,
  LlmStreamChunk,
  LlmTool,
  McpToolResult,
  Message,
  Result,
} from '@mcp-abap-adt/llm-agent';
import { McpError, NoopToolCache } from '@mcp-abap-adt/llm-agent';
import { SmartAgent } from '../../../agent.js';
import { NoopMetrics } from '../../../metrics/noop-metrics.js';
import {
  HeuristicToolAvailabilityPolicy,
  type IToolAvailabilityPolicy,
} from '../../../policy/tool-availability-policy.js';
import { ToolAvailabilityRegistry } from '../../../policy/tool-availability-registry.js';
import { makeDefaultDeps } from '../../../testing/index.js';
import { NoopTracer } from '../../../tracer/noop-tracer.js';
import { DefaultPipeline } from '../../default-pipeline.js';
import { executeToolBatchWithHeartbeat } from '../tool-loop-core.js';

/** An LLM that calls `T` on its first call and answers 'done' after; records the tool names of every call. */
function scriptedLlm(): ILlm & { toolLists: string[][] } {
  const toolLists: string[][] = [];
  let call = 0;
  return {
    toolLists,
    model: 'scripted',
    async chat(): Promise<Result<LlmResponse, LlmError>> {
      return { ok: true, value: { content: 'unused', finishReason: 'stop' } };
    },
    async *streamChat(
      _messages: Message[],
      tools?: LlmTool[],
    ): AsyncIterable<Result<LlmStreamChunk, LlmError>> {
      toolLists.push((tools ?? []).map((t) => t.name));
      call++;
      if (call === 1) {
        yield {
          ok: true,
          value: {
            content: '',
            toolCalls: [{ id: 'c1', name: 'T', arguments: {} }],
            finishReason: 'tool_calls',
          },
        };
        return;
      }
      yield { ok: true, value: { content: 'done', finishReason: 'stop' } };
    },
    async healthCheck() {
      return { ok: true as const, value: true };
    },
  } as ILlm & { toolLists: string[][] };
}

/** An MCP client with the tools `T` and `U`; `T` answers `object not found` on its first call. */
function failingOnceClient(): IMcpClient & { calls: number } {
  const c = {
    calls: 0,
    async listTools() {
      return {
        ok: true as const,
        value: [
          { name: 'T', description: 'tool T', inputSchema: {} },
          { name: 'U', description: 'tool U', inputSchema: {} },
        ],
      };
    },
    async callTool(name: string): Promise<Result<McpToolResult, McpError>> {
      c.calls++;
      if (name === 'T' && c.calls === 1)
        return { ok: false, error: new McpError('object not found') };
      return { ok: true, value: { content: `result of ${name}` } };
    },
  };
  return c as unknown as IMcpClient & { calls: number };
}

type Step = { name: string; data: unknown };

async function run(policy: IToolAvailabilityPolicy | undefined) {
  const llm = scriptedLlm();
  const client = failingOnceClient();
  const { deps } = makeDefaultDeps({ mcpClients: [client] });
  const pipeline = new DefaultPipeline();
  pipeline.initialize({
    ...deps,
    mainLlm: llm,
    agentConfig: { mode: 'hard', maxIterations: 5 },
    ...(policy ? { toolAvailabilityPolicy: policy } : {}),
  } as never);
  const agent = new SmartAgent(
    {
      ...deps,
      mainLlm: llm,
      pipeline,
      ...(policy ? { toolAvailabilityPolicy: policy } : {}),
    },
    { maxIterations: 5, mode: 'hard' },
  );
  const steps: Step[] = [];
  // The session's registry, as the SessionGraph hands it to every request of the session.
  const toolAvailability = new ToolAvailabilityRegistry();
  const options = {
    sessionId: 's-1',
    toolAvailability,
    sessionLogger: {
      logStep(name: string, data: unknown) {
        steps.push({ name, data });
      },
    },
  } as CallOptions;
  const first = await agent.process('use T', options);
  assert.ok(first.ok, !first.ok ? first.error.message : '');
  const second = await agent.process('use T again', options);
  assert.ok(second.ok, !second.ok ? second.error.message : '');
  return { llm, client, steps };
}

const blacklisted = (steps: Step[]) =>
  steps.filter((s) => s.name === 'tool_blacklisted_T');

describe('U8: the tool availability policy (DefaultPipeline)', () => {
  it('no policy injected → nothing blocked: the error reaches the LLM, T stays offered in the next iteration and request', async () => {
    const { llm, steps } = await run(undefined);
    const toolResults = steps.filter((s) => s.name === 'mcp_result_T');
    assert.deepEqual(
      toolResults.map((s) => (s.data as { result: string }).result),
      ['object not found'],
      'the tool error reaches the LLM as the tool result',
    );
    assert.deepEqual(blacklisted(steps), []);
    assert.ok(llm.toolLists[0].includes('T'), 'T offered on the first call');
    assert.ok(
      llm.toolLists[1].includes('T'),
      `T still offered in the next iteration: ${llm.toolLists[1]}`,
    );
    assert.ok(
      llm.toolLists[2].includes('T'),
      `T still offered in the next request: ${llm.toolLists[2]}`,
    );
  });

  it('HeuristicToolAvailabilityPolicy injected → 30.1.0: T blacklisted, filtered from the next iteration and the next request of the session', async () => {
    const before = Date.now();
    const { llm, steps } = await run(
      new HeuristicToolAvailabilityPolicy({ ttlMs: 60_000 }),
    );
    const step = blacklisted(steps);
    assert.equal(step.length, 1);
    const data = step[0].data as { reason: string; blockedUntil: number };
    assert.equal(data.reason, 'object not found');
    assert.ok(data.blockedUntil >= before + 60_000, String(data.blockedUntil));
    assert.ok(data.blockedUntil <= Date.now() + 60_000);
    assert.ok(llm.toolLists[0].includes('T'));
    assert.ok(
      !llm.toolLists[1].includes('T'),
      'filtered in the next iteration',
    );
    assert.ok(llm.toolLists[1].includes('U'), 'only T is filtered');
    assert.ok(!llm.toolLists[2].includes('T'), 'filtered in the next request');
  });

  it('a policy answering undefined for everything → nothing blocked; it is asked about the failed call', async () => {
    const asked: [string, string][] = [];
    const { llm, steps } = await run({
      onToolError(toolName, errorText) {
        asked.push([toolName, errorText]);
        return undefined;
      },
    });
    assert.deepEqual(asked, [['T', 'object not found']]);
    assert.deepEqual(blacklisted(steps), []);
    assert.ok(llm.toolLists[1].includes('T'));
    assert.ok(llm.toolLists[2].includes('T'));
  });
});

/** The legacy SmartAgent loop (no pipeline), two requests of one session. */
async function runLegacy(policy: IToolAvailabilityPolicy | undefined) {
  const llm = scriptedLlm();
  const client = failingOnceClient();
  const { deps } = makeDefaultDeps({ mcpClients: [client] });
  const agent = new SmartAgent(
    {
      ...deps,
      mainLlm: llm,
      ...(policy ? { toolAvailabilityPolicy: policy } : {}),
    },
    { maxIterations: 5, mode: 'hard' },
  );
  const steps: Step[] = [];
  const options = {
    sessionId: 's-legacy',
    sessionLogger: {
      logStep(name: string, data: unknown) {
        steps.push({ name, data });
      },
    },
  } as CallOptions;
  const first = await agent.process('use T', options);
  assert.ok(first.ok, !first.ok ? first.error.message : '');
  const second = await agent.process('use T again', options);
  assert.ok(second.ok, !second.ok ? second.error.message : '');
  return { llm, steps };
}

describe('U8: the tool availability policy (legacy SmartAgent loop, no pipeline)', () => {
  it('no policy injected → nothing blocked: T stays offered in the next iteration and request', async () => {
    const { llm, steps } = await runLegacy(undefined);
    assert.deepEqual(blacklisted(steps), []);
    assert.ok(llm.toolLists[0].includes('T'), 'T offered on the first call');
    assert.ok(
      llm.toolLists[1].includes('T'),
      `T still offered in the next iteration: ${llm.toolLists[1]}`,
    );
    assert.ok(
      llm.toolLists[2].includes('T'),
      `T still offered in the next request: ${llm.toolLists[2]}`,
    );
  });

  it('HeuristicToolAvailabilityPolicy injected → T blacklisted and filtered from the next iteration and request', async () => {
    const before = Date.now();
    const { llm, steps } = await runLegacy(
      new HeuristicToolAvailabilityPolicy({ ttlMs: 60_000 }),
    );
    const step = blacklisted(steps);
    assert.equal(step.length, 1);
    const data = step[0].data as { reason: string; blockedUntil: number };
    assert.equal(data.reason, 'object not found');
    assert.ok(data.blockedUntil >= before + 60_000);
    assert.ok(data.blockedUntil <= Date.now() + 60_000);
    assert.ok(llm.toolLists[0].includes('T'));
    assert.ok(
      !llm.toolLists[1].includes('T'),
      'filtered in the next iteration',
    );
    assert.ok(llm.toolLists[1].includes('U'), 'only T is filtered');
    assert.ok(!llm.toolLists[2].includes('T'), 'filtered in the next request');
  });
});

describe('U8: an external (client-provided) tool is never offered to the policy (#91)', () => {
  it('a failed call whose name is a client-provided tool → the policy is not asked, nothing blocked', async () => {
    const asked: string[] = [];
    const policy: IToolAvailabilityPolicy = {
      onToolError(toolName) {
        asked.push(toolName);
        return { ttlMs: 60_000 };
      },
    };
    const client = failingOnceClient();
    const registry = new ToolAvailabilityRegistry();
    const tracer = new NoopTracer();
    const gen = executeToolBatchWithHeartbeat({
      batch: [{ id: 'c1', name: 'T', arguments: {} }],
      toolClientMap: new Map([['T', client]]),
      toolCache: new NoopToolCache(),
      tracer,
      metrics: new NoopMetrics(),
      parentSpan: tracer.startSpan('root'),
      toolAvailabilityRegistry: registry,
      toolAvailabilityPolicy: policy,
      sessionId: 's-ext',
      externalToolNames: new Set(['T']),
      currentTools: [{ name: 'T', description: 'T', inputSchema: {} }],
      toolCallCount: 0,
      timingLog: [],
      heartbeatMs: null,
      options: undefined,
    });
    let next = await gen.next();
    while (!next.done) next = await gen.next();
    assert.equal(next.value.escalated, false);
    assert.deepEqual(asked, []);
    assert.deepEqual([...registry.getBlockedToolNames('s-ext')], []);
    if (!next.value.escalated)
      assert.deepEqual(
        next.value.currentTools.map((t) => t.name),
        ['T'],
      );
  });
});
