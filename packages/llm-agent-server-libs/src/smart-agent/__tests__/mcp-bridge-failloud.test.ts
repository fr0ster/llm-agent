import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IMcpClient } from '@mcp-abap-adt/llm-agent';
import { McpError } from '@mcp-abap-adt/llm-agent';
import { buildMcpBridge } from '../smart-server.js';

test('bridge throws on an availability listTools error (not "Tool not found")', async () => {
  const client = {
    async listTools() {
      return {
        ok: false as const,
        error: new McpError('Not connected', 'MCP_NOT_CONNECTED'),
      };
    },
    async callTool() {
      return { ok: true as const, value: { content: 'x', isError: false } };
    },
  } as unknown as IMcpClient;
  const bridge = buildMcpBridge([client]);
  await assert.rejects(
    () => bridge('GetTable', {}),
    /not connected|MCP_NOT_CONNECTED/i,
  );
});

test('bridge throws on an availability callTool error', async () => {
  const client = {
    async listTools() {
      return {
        ok: true as const,
        value: [{ name: 'GetTable', description: '', inputSchema: {} }],
      };
    },
    async callTool() {
      return {
        ok: false as const,
        error: new McpError(
          'MCP error -32001: Request timed out',
          'MCP_TIMEOUT',
        ),
      };
    },
  } as unknown as IMcpClient;
  const bridge = buildMcpBridge([client]);
  await assert.rejects(() => bridge('GetTable', {}), /timed out|MCP_TIMEOUT/i);
});

test('bridge returns "Tool not found" when no client owns the name', async () => {
  const client = {
    async listTools() {
      return { ok: true as const, value: [] };
    },
    async callTool() {
      return { ok: true as const, value: { content: 'x', isError: false } };
    },
  } as unknown as IMcpClient;
  const bridge = buildMcpBridge([client]);
  assert.match(await bridge('Nope', {}), /Tool not found/);
});

test('bridge returns a tool-level error as text (not a throw)', async () => {
  const client = {
    async listTools() {
      return {
        ok: true as const,
        value: [{ name: 'GetTable', description: '', inputSchema: {} }],
      };
    },
    async callTool() {
      return {
        ok: false as const,
        error: new McpError('table not found', 'MCP_ERROR'),
      };
    },
  } as unknown as IMcpClient;
  const bridge = buildMcpBridge([client]);
  assert.equal(await bridge('GetTable', {}), 'table not found');
});
