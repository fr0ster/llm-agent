import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  IMcpClient,
  IMcpFailureClassifier,
} from '@mcp-abap-adt/llm-agent';
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

// ---------------------------------------------------------------------------
// Classifier injection tests (Part A)
// ---------------------------------------------------------------------------

test('bridge uses CUSTOM classifier — custom unavailable error THROWS', async () => {
  // A classifier that maps ANY error to 'unavailable', regardless of code.
  const allUnavailable: IMcpFailureClassifier = {
    classify: async () => 'unavailable',
  };
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
        // MCP_ERROR is NOT normally unavailable — but the custom classifier says it is.
        error: new McpError('custom-mapped error', 'MCP_ERROR'),
      };
    },
  } as unknown as IMcpClient;
  const bridge = buildMcpBridge([client], allUnavailable);
  await assert.rejects(() => bridge('GetTable', {}), /custom-mapped error/);
});

test('bridge uses CUSTOM classifier — tool-error with default classifier stays text', async () => {
  // Default classifier (MCP_ERROR → tool-error): should NOT throw.
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
        error: new McpError('benign tool error', 'MCP_ERROR'),
      };
    },
  } as unknown as IMcpClient;
  // No classifier arg → default DefaultMcpFailureClassifier (MCP_ERROR = tool-error).
  const bridge = buildMcpBridge([client]);
  assert.equal(await bridge('GetTable', {}), 'benign tool error');
});

// ---------------------------------------------------------------------------
// Probe-wiring tests (Part B) — probe must reach the classifier
// ---------------------------------------------------------------------------

test('bridge passes per-client probe to classifier — DOWN: throws when server is unreachable', async () => {
  // assumeToolErrorWhenNoProbe: if no probe is wired (old code path), falls back to
  // 'tool-error' → no throw → assert.rejects FAILS (discriminating on old code).
  // With probe wired (new code): probe()===false → 'unavailable' → throws ✓.
  const assumeToolErrorWhenNoProbe: IMcpFailureClassifier = {
    classify: async (_err, probeHealth) => {
      if (probeHealth === undefined) return 'tool-error';
      return (await probeHealth()) === false ? 'unavailable' : 'tool-error';
    },
  };
  const client = {
    async listTools() {
      return {
        ok: true as const,
        value: [{ name: 't', description: '', inputSchema: {} }],
      };
    },
    async callTool() {
      return { ok: false as const, error: new McpError('boom', 'MCP_ERROR') };
    },
    // healthCheck resolves with value:false → server is DOWN
    async healthCheck() {
      return { ok: true as const, value: false };
    },
  } as unknown as IMcpClient;
  const bridge = buildMcpBridge([client], assumeToolErrorWhenNoProbe);
  await assert.rejects(() => bridge('t', {}), /boom/);
});

test('bridge passes per-client probe to classifier — UP: returns tool-error text when server is reachable', async () => {
  // assumeUnavailableWhenNoProbe: if no probe is wired (old code path), falls back to
  // 'unavailable' → throws → assert.equal fails (discriminating on old code).
  // With probe wired (new code): probe()===true → 'tool-error' → returns 'boom' ✓.
  const assumeUnavailableWhenNoProbe: IMcpFailureClassifier = {
    classify: async (_err, probeHealth) => {
      if (probeHealth === undefined) return 'unavailable';
      return (await probeHealth()) === false ? 'unavailable' : 'tool-error';
    },
  };
  const client = {
    async listTools() {
      return {
        ok: true as const,
        value: [{ name: 't', description: '', inputSchema: {} }],
      };
    },
    async callTool() {
      return { ok: false as const, error: new McpError('boom', 'MCP_ERROR') };
    },
    // healthCheck resolves with value:true → server is UP
    async healthCheck() {
      return { ok: true as const, value: true };
    },
  } as unknown as IMcpClient;
  const bridge = buildMcpBridge([client], assumeUnavailableWhenNoProbe);
  assert.equal(await bridge('t', {}), 'boom');
});
