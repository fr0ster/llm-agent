/**
 * B-1: Real callMcp bridge for the Stepper path.
 *
 * Tests the server's `buildMcpBridge` helper using a fake IMcpClient
 * (not a fake callMcp stub) and asserts:
 *  1. The bridge dispatches to the MCP client's callTool.
 *  2. The tool result reaches the executor / knowledge-RAG write.
 *  3. The bridge returns an error string (not throw) when callTool fails.
 *  4. The bridge returns "Tool not found" when no client owns the tool.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IMcpClient } from '@mcp-abap-adt/llm-agent';
import { TokenLedger } from '@mcp-abap-adt/llm-agent';
import {
  InMemoryKnowledgeBackend,
  KnowledgeRag,
} from '@mcp-abap-adt/llm-agent-libs';
import { buildStepperRoot } from '../build-stepper-root.js';
import { buildMcpBridge } from '../smart-server.js';

const ZERO = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

// ---------------------------------------------------------------------------
// Fake IMcpClient — implements the full interface, records calls
// ---------------------------------------------------------------------------

function fakeMcpClient(
  tools: string[],
  results: Record<string, string>,
): IMcpClient & { callsMade: { name: string; args: unknown }[] } {
  const callsMade: { name: string; args: unknown }[] = [];
  return {
    callsMade,
    async listTools() {
      return {
        ok: true as const,
        value: tools.map((name) => ({
          name,
          description: name,
          inputSchema: {},
        })),
      };
    },
    async callTool(name: string, args: Record<string, unknown>) {
      callsMade.push({ name, args });
      const val = results[name];
      if (val === undefined) {
        return {
          ok: false as const,
          error: {
            message: `no result for ${name}`,
            code: 'not_found' as never,
          },
        };
      }
      return { ok: true as const, value: { content: val } };
    },
  };
}

// ---------------------------------------------------------------------------
// Unit tests of buildMcpBridge (the exported bridge factory)
// ---------------------------------------------------------------------------

test('bridge dispatches callTool to the first owning client and returns string content', async () => {
  const client = fakeMcpClient(['ReadProgram'], { ReadProgram: 'REPORT z.' });
  const callMcp = buildMcpBridge([client]);

  const result = await callMcp('ReadProgram', { program: 'Z' });

  assert.equal(result, 'REPORT z.', 'bridge should return tool result text');
  assert.equal(client.callsMade.length, 1);
  assert.equal(client.callsMade[0].name, 'ReadProgram');
});

test('bridge serialises structured content to JSON', async () => {
  const client = fakeMcpClient(['GetTable'], {}) as IMcpClient & {
    callsMade: { name: string; args: unknown }[];
  };
  // Override callTool to return structured content
  const clientWithStructured: IMcpClient & {
    callsMade: { name: string; args: unknown }[];
  } = {
    ...client,
    async callTool(name: string, args: Record<string, unknown>) {
      client.callsMade.push({ name, args });
      return {
        ok: true as const,
        value: { content: { rows: ['A', 'B'] } },
      };
    },
  };

  const callMcp = buildMcpBridge([clientWithStructured]);
  const result = await callMcp('GetTable', {});
  assert.ok(
    result.includes('"rows"'),
    'structured content should be JSON-stringified',
  );
});

test('bridge returns error message string when callTool fails (no throw)', async () => {
  const client: IMcpClient = {
    async listTools() {
      return {
        ok: true as const,
        value: [{ name: 'FailTool', description: '', inputSchema: {} }],
      };
    },
    async callTool() {
      return {
        ok: false as const,
        error: { message: 'server timeout', code: 'timeout' as never },
      };
    },
  };
  const callMcp = buildMcpBridge([client]);
  const result = await callMcp('FailTool', {});
  assert.equal(
    result,
    'server timeout',
    'bridge should return error message, not throw',
  );
});

test('bridge returns Tool-not-found string when no client owns the tool', async () => {
  const client = fakeMcpClient(['OtherTool'], { OtherTool: 'ok' });
  const callMcp = buildMcpBridge([client]);
  const result = await callMcp('UnknownTool', {});
  assert.ok(
    result.startsWith('Tool not found'),
    `expected Tool not found, got: ${result}`,
  );
});

test('bridge skips a client whose listTools fails and tries the next', async () => {
  const broken: IMcpClient = {
    async listTools() {
      return {
        ok: false as const,
        error: { message: 'disconnected', code: 'disconnected' as never },
      };
    },
    async callTool() {
      return {
        ok: false as const,
        error: { message: 'should not be called', code: 'err' as never },
      };
    },
  };
  const good = fakeMcpClient(['ReadProgram'], { ReadProgram: 'source code' });
  const callMcp = buildMcpBridge([broken, good]);
  const result = await callMcp('ReadProgram', {});
  assert.equal(result, 'source code');
  assert.equal(good.callsMade.length, 1);
});

// ---------------------------------------------------------------------------
// Integration: bridge wired into buildStepperRoot → executor dispatches call
// ---------------------------------------------------------------------------

test('bridge dispatched through buildStepperRoot: tool result reaches knowledgeRag write', async () => {
  /**
   * LLM scripted to emit one tool call (ReadProgram), then a final "done" response.
   * The CyclicReActExecutor calls callMcp (bridged to the fake IMcpClient),
   * and the result flows through the executor.
   */
  const client = fakeMcpClient(['ReadProgram'], {
    ReadProgram: 'REPORT ztest.',
  });

  const backend = new InMemoryKnowledgeBackend();
  const knowledgeRag = new KnowledgeRag(backend, 'sess-b1');

  // Scripted LLM: first response emits a tool call; second response is the final answer.
  let llmCalls = 0;
  const stubLlm = {
    name: 'stub',
    model: 'stub',
    async chat() {
      llmCalls++;
      if (llmCalls === 1) {
        return {
          ok: true as const,
          value: {
            content: 'fetching source',
            toolCalls: [
              { name: 'ReadProgram', arguments: { program: 'ZTEST' } },
            ],
            usage: ZERO,
          },
        };
      }
      // Second call: provide the final answer after tool result injected
      return {
        ok: true as const,
        value: {
          content: 'The program is REPORT ztest.',
          usage: ZERO,
        },
      };
    },
    async *streamChat() {
      yield {
        ok: true as const,
        value: { content: 'done', finishReason: 'stop', usage: ZERO },
      };
    },
  };

  // Build the stepper root using the real buildMcpBridge
  const callMcp = buildMcpBridge([client]);
  const built = await buildStepperRoot({
    coordCfg: { mode: 'cyclic-react' },
    registry: new Map(),
    makeLlm: async () => stubLlm as never,
    knowledgeRagFor: () => knowledgeRag as never,
    toolsRag: {
      async query() {
        return [{ name: 'ReadProgram' }];
      },
      lookup(name: string) {
        return name === 'ReadProgram'
          ? ({ name: 'ReadProgram' } as never)
          : undefined;
      },
    } as never,
    callMcp,
    mintStepperId: (() => {
      let i = 0;
      return () => `s${i++}`;
    })(),
  });

  const result = await built.rootStepper.run({
    prompt: 'read the program',
    knowledgeRag: knowledgeRag as never,
    toolsRag: {
      async query() {
        return [{ name: 'ReadProgram' }];
      },
      lookup(name: string) {
        return name === 'ReadProgram'
          ? ({ name: 'ReadProgram' } as never)
          : undefined;
      },
    } as never,
    budget: { depthRemaining: 0, tokens: new TokenLedger(100_000) },
    identity: {
      traceId: 'trace-b1',
      turnId: 'turn-b1',
      sessionId: 'sess-b1',
      stepperId: 's0',
    },
    toolSafety: {
      mutationPolicy: 'confirm',
      knownReadOnlyTools: new Set(['ReadProgram']),
    },
  });

  assert.equal(result.status, 'ok', `expected ok, got: ${result.status}`);
  // The bridge dispatched callTool to the fake IMcpClient
  assert.equal(
    client.callsMade.length,
    1,
    'bridge should have dispatched callTool exactly once',
  );
  assert.equal(client.callsMade[0].name, 'ReadProgram');
});
