/**
 * Spec §10.5.3 M10, M11 — the server's MCP bridge and its authoritative
 * snapshot fail loud on a client that cannot list its tools.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IMcpClient } from '@mcp-abap-adt/llm-agent';
import { McpError } from '@mcp-abap-adt/llm-agent';
import { buildMcpBridge, SmartServer } from '../smart-server.js';
import { constructionSeams } from './construction-seams.js';

const TOOL = { name: 'GetTable', description: '', inputSchema: {} };

test('M10: a listTools error the classifier calls a tool error → the bridge throws it (not the next client)', async () => {
  const listError = new McpError('cannot list', 'MCP_ERROR');
  let secondCalled = false;
  const failing = {
    async listTools() {
      return { ok: false as const, error: listError };
    },
    async callTool() {
      return { ok: true as const, value: { content: 'x' } };
    },
  } as unknown as IMcpClient;
  const second = {
    async listTools() {
      return { ok: true as const, value: [TOOL] };
    },
    async callTool() {
      secondCalled = true;
      return { ok: true as const, value: { content: 'from second' } };
    },
  } as unknown as IMcpClient;
  const bridge = buildMcpBridge([failing, second]);
  await assert.rejects(bridge('GetTable', {}), (e: unknown) => e === listError);
  assert.equal(secondCalled, false);
});

test('M10: a callTool tool error still comes back as a tool result (unchanged)', async () => {
  const client = {
    async listTools() {
      return { ok: true as const, value: [TOOL] };
    },
    async callTool() {
      return {
        ok: false as const,
        error: new McpError('table not found', 'MCP_ERROR'),
      };
    },
  } as unknown as IMcpClient;
  const bridge = buildMcpBridge([client]);
  assert.deepEqual(await bridge('GetTable', {}), {
    text: 'table not found',
    isError: true,
  });
});

type Internals = {
  buildSharedPipelineInfra(input: {
    toolsRag: undefined;
    resolvedEmbedder: undefined;
    mcpClients: IMcpClient[] | undefined;
  }): Promise<void>;
  _namespacedTools?: readonly { name: string }[];
  _toolProvenance?: ReadonlyMap<string, unknown>;
};

test('M11: one failing client → the snapshot rejects with its McpError; a later call after recovery builds it', async () => {
  let down = true;
  const listError = new McpError('Not connected', 'MCP_NOT_CONNECTED');
  const flaky = {
    async listTools() {
      return down
        ? { ok: false as const, error: listError }
        : {
            ok: true as const,
            value: [{ name: 'B', description: '', inputSchema: {} }],
          };
    },
    async callTool() {
      return { ok: true as const, value: { content: 'x' } };
    },
  } as unknown as IMcpClient;
  const healthy = {
    async listTools() {
      return {
        ok: true as const,
        value: [{ name: 'A', description: '', inputSchema: {} }],
      };
    },
    async callTool() {
      return { ok: true as const, value: { content: 'x' } };
    },
  } as unknown as IMcpClient;
  const server = new SmartServer({}, constructionSeams) as unknown as Internals;

  await assert.rejects(
    server.buildSharedPipelineInfra({
      toolsRag: undefined,
      resolvedEmbedder: undefined,
      mcpClients: [healthy, flaky],
    }),
    (e: unknown) => e === listError,
  );
  assert.equal(server._toolProvenance, undefined, 'nothing memoized');
  assert.equal(server._namespacedTools, undefined, 'nothing memoized');

  down = false;
  await server.buildSharedPipelineInfra({
    toolsRag: undefined,
    resolvedEmbedder: undefined,
    mcpClients: [healthy, flaky],
  });
  assert.ok(server._toolProvenance?.has('A'));
  assert.ok(server._toolProvenance?.has('B'));
});

test('M11: a client whose listTools throws → the snapshot rejects with an McpError', async () => {
  const throwing = {
    async listTools() {
      throw new Error('boom');
    },
    async callTool() {
      return { ok: true as const, value: { content: 'x' } };
    },
  } as unknown as IMcpClient;
  const server = new SmartServer({}, constructionSeams) as unknown as Internals;
  await assert.rejects(
    server.buildSharedPipelineInfra({
      toolsRag: undefined,
      resolvedEmbedder: undefined,
      mcpClients: [throwing],
    }),
    (e: unknown) => e instanceof McpError && /boom/.test(e.message),
  );
  assert.equal(server._toolProvenance, undefined);
});
