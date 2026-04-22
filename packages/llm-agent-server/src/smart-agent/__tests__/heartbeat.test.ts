import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  ILlm,
  IMcpClient,
  LlmError,
  LlmResponse,
  LlmStreamChunk,
  McpError,
  McpTool,
  McpToolResult,
  Result,
  TimingEntry,
  ToolHeartbeat,
} from '@mcp-abap-adt/llm-agent';
import { SmartAgent } from '../agent.js';
import { makeDefaultDeps } from '../testing/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** MCP client stub with configurable per-tool delay. */
function makeDelayedMcpClient(
  tools: McpTool[],
  results: Map<string, { content: string; delayMs: number }>,
): IMcpClient & { callCount: number } {
  let callCount = 0;
  return {
    get callCount() {
      return callCount;
    },
    async listTools(): Promise<Result<McpTool[], McpError>> {
      return { ok: true, value: tools };
    },
    async callTool(name: string): Promise<Result<McpToolResult, McpError>> {
      callCount++;
      const entry = results.get(name);
      const delayMs = entry?.delayMs ?? 0;
      if (delayMs > 0) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
      return {
        ok: true,
        value: { content: entry?.content ?? `result of ${name}` },
      };
    },
  };
}

/** LLM stub that returns tool_calls on first call, then final text. */
function makeToolCallingLlm(
  toolCallNames: string[],
  finalContent: string,
): ILlm & { callCount: number } {
  let callCount = 0;
  return {
    get callCount() {
      return callCount;
    },
    async chat(): Promise<Result<LlmResponse, LlmError>> {
      callCount++;
      if (callCount === 1) {
        return {
          ok: true,
          value: {
            content: '',
            finishReason: 'tool_calls',
            toolCalls: toolCallNames.map((name, i) => ({
              id: `call_${i}`,
              name,
              arguments: {},
            })),
          },
        };
      }
      return {
        ok: true,
        value: { content: finalContent, finishReason: 'stop' },
      };
    },
    async *streamChat(): AsyncIterable<Result<LlmStreamChunk, LlmError>> {
      callCount++;
      if (callCount === 1) {
        yield {
          ok: true,
          value: {
            content: '',
            toolCalls: toolCallNames.map((name, i) => ({
              id: `call_${i}`,
              name,
              arguments: {},
            })),
            finishReason: 'tool_calls',
          },
        };
        return;
      }
      yield {
        ok: true,
        value: { content: finalContent, finishReason: 'stop' },
      };
    },
  };
}

/** Collect all chunks from streamProcess into arrays. */
async function collectStream(agent: SmartAgent, message: string) {
  const heartbeats: ToolHeartbeat[] = [];
  let timing: TimingEntry[] | undefined;
  const contentParts: string[] = [];

  for await (const chunk of agent.streamProcess(message)) {
    if (!chunk.ok) continue;
    if (chunk.value.heartbeat) {
      heartbeats.push(chunk.value.heartbeat);
    }
    if (chunk.value.timing) {
      timing = chunk.value.timing;
    }
    if (chunk.value.content) {
      contentParts.push(chunk.value.content);
    }
  }
  return { heartbeats, timing, content: contentParts.join('') };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG = { maxIterations: 5, mode: 'hard' as const };

describe('Heartbeat — emitted during slow MCP tool execution', () => {
  it('yields heartbeat chunks while tool is executing', async () => {
    const client = makeDelayedMcpClient(
      [{ name: 'slow_tool', description: 'Slow', inputSchema: {} }],
      new Map([['slow_tool', { content: 'done', delayMs: 350 }]]),
    );
    const llm = makeToolCallingLlm(['slow_tool'], 'final answer');
    const { deps } = makeDefaultDeps({ mcpClients: [client] });
    deps.mainLlm = llm;

    const agent = new SmartAgent(deps, {
      ...DEFAULT_CONFIG,
      heartbeatIntervalMs: 100,
    });
    const { heartbeats } = await collectStream(agent, 'test');

    assert.ok(
      heartbeats.length >= 2,
      `expected >=2 heartbeats, got ${heartbeats.length}`,
    );
    for (const hb of heartbeats) {
      assert.equal(hb.tool, 'slow_tool');
      assert.ok(hb.elapsed > 0, 'elapsed should be positive');
    }
  });

  it('heartbeat elapsed increases over time', async () => {
    const client = makeDelayedMcpClient(
      [{ name: 'slow_tool', description: 'Slow', inputSchema: {} }],
      new Map([['slow_tool', { content: 'done', delayMs: 450 }]]),
    );
    const llm = makeToolCallingLlm(['slow_tool'], 'result');
    const { deps } = makeDefaultDeps({ mcpClients: [client] });
    deps.mainLlm = llm;

    const agent = new SmartAgent(deps, {
      ...DEFAULT_CONFIG,
      heartbeatIntervalMs: 100,
    });
    const { heartbeats } = await collectStream(agent, 'test');

    assert.ok(heartbeats.length >= 2);
    for (let i = 1; i < heartbeats.length; i++) {
      assert.ok(
        heartbeats[i].elapsed > heartbeats[i - 1].elapsed,
        `heartbeat[${i}].elapsed (${heartbeats[i].elapsed}) should be > heartbeat[${i - 1}].elapsed (${heartbeats[i - 1].elapsed})`,
      );
    }
  });

  it('no heartbeat for fast tools', async () => {
    const client = makeDelayedMcpClient(
      [{ name: 'fast_tool', description: 'Fast', inputSchema: {} }],
      new Map([['fast_tool', { content: 'instant', delayMs: 0 }]]),
    );
    const llm = makeToolCallingLlm(['fast_tool'], 'done');
    const { deps } = makeDefaultDeps({ mcpClients: [client] });
    deps.mainLlm = llm;

    const agent = new SmartAgent(deps, {
      ...DEFAULT_CONFIG,
      heartbeatIntervalMs: 500,
    });
    const { heartbeats } = await collectStream(agent, 'test');

    assert.equal(
      heartbeats.length,
      0,
      'fast tool should not produce heartbeats',
    );
  });
});

describe('Heartbeat — multiple concurrent tools', () => {
  it('heartbeats report only still-pending tools', async () => {
    const client = makeDelayedMcpClient(
      [
        { name: 'fast_tool', description: 'Fast', inputSchema: {} },
        { name: 'slow_tool', description: 'Slow', inputSchema: {} },
      ],
      new Map([
        ['fast_tool', { content: 'fast result', delayMs: 50 }],
        ['slow_tool', { content: 'slow result', delayMs: 400 }],
      ]),
    );
    const llm = makeToolCallingLlm(['fast_tool', 'slow_tool'], 'final');
    const { deps } = makeDefaultDeps({ mcpClients: [client] });
    deps.mainLlm = llm;

    const agent = new SmartAgent(deps, {
      ...DEFAULT_CONFIG,
      heartbeatIntervalMs: 100,
    });
    const { heartbeats } = await collectStream(agent, 'test');

    assert.ok(heartbeats.length >= 1, 'should have heartbeats for slow_tool');
    // After fast_tool completes (~50ms), only slow_tool should remain
    const lateHeartbeats = heartbeats.filter((hb) => hb.elapsed > 100);
    const lateToolNames = new Set(lateHeartbeats.map((hb) => hb.tool));
    assert.ok(
      !lateToolNames.has('fast_tool'),
      'fast_tool should not appear in late heartbeats',
    );
  });
});

describe('Timing — breakdown included in final chunk', () => {
  it('timing includes llm_call and tool entries', async () => {
    const client = makeDelayedMcpClient(
      [{ name: 'my_tool', description: 'T', inputSchema: {} }],
      new Map([['my_tool', { content: 'result', delayMs: 50 }]]),
    );
    const llm = makeToolCallingLlm(['my_tool'], 'answer');
    const { deps } = makeDefaultDeps({ mcpClients: [client] });
    deps.mainLlm = llm;

    const agent = new SmartAgent(deps, DEFAULT_CONFIG);
    const { timing } = await collectStream(agent, 'test');

    assert.ok(timing, 'timing should be present');
    const phases = timing.map((t) => t.phase);
    assert.ok(phases.includes('llm_call_1'), 'should have llm_call_1');
    assert.ok(phases.includes('tool_my_tool'), 'should have tool_my_tool');
    assert.ok(phases.includes('llm_call_2'), 'should have llm_call_2');
    assert.ok(phases.includes('total'), 'should have total');
  });

  it('timing durations are positive numbers', async () => {
    const client = makeDelayedMcpClient(
      [{ name: 'tool', description: 'T', inputSchema: {} }],
      new Map([['tool', { content: 'ok', delayMs: 10 }]]),
    );
    const llm = makeToolCallingLlm(['tool'], 'done');
    const { deps } = makeDefaultDeps({ mcpClients: [client] });
    deps.mainLlm = llm;

    const agent = new SmartAgent(deps, DEFAULT_CONFIG);
    const { timing } = await collectStream(agent, 'test');

    assert.ok(timing);
    for (const entry of timing) {
      assert.ok(
        typeof entry.duration === 'number' && entry.duration >= 0,
        `${entry.phase} duration should be >= 0, got ${entry.duration}`,
      );
    }
  });

  it('total >= sum of individual phases', async () => {
    const client = makeDelayedMcpClient(
      [{ name: 'tool', description: 'T', inputSchema: {} }],
      new Map([['tool', { content: 'ok', delayMs: 50 }]]),
    );
    const llm = makeToolCallingLlm(['tool'], 'done');
    const { deps } = makeDefaultDeps({ mcpClients: [client] });
    deps.mainLlm = llm;

    const agent = new SmartAgent(deps, DEFAULT_CONFIG);
    const { timing } = await collectStream(agent, 'test');

    assert.ok(timing);
    const total = timing.find((t) => t.phase === 'total');
    assert.ok(total, 'total entry should exist');
    const parts = timing.filter((t) => t.phase !== 'total');
    const sumParts = parts.reduce((s, t) => s + t.duration, 0);
    assert.ok(
      total.duration >= sumParts - 5,
      `total (${total.duration}ms) should be >= sum of parts (${sumParts}ms)`,
    );
  });
});

describe('Timing — no tool calls', () => {
  it('timing has llm_call_1 and total only', async () => {
    const { deps } = makeDefaultDeps({
      llmResponses: [{ content: 'hello', finishReason: 'stop' }],
    });
    const agent = new SmartAgent(deps, DEFAULT_CONFIG);
    const { timing } = await collectStream(agent, 'test');

    assert.ok(timing, 'timing should be present');
    const phases = timing.map((t) => t.phase);
    assert.ok(phases.includes('llm_call_1'), 'should have llm_call_1');
    assert.ok(phases.includes('total'), 'should have total');
    assert.equal(timing.length, 2, 'should have exactly 2 entries');
  });
});
