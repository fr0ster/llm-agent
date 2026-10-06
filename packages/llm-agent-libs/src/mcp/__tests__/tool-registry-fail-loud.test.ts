import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IMcpClient, McpTool } from '@mcp-abap-adt/llm-agent';
import { McpError, OrchestratorError } from '@mcp-abap-adt/llm-agent';
import type { IMcpConnectionStrategy } from '../../interfaces/mcp-connection-strategy.js';
import { McpToolRegistry } from '../tool-registry.js';

// Spec §10.5.3 M3, M4 — a client that cannot list its tools, or a configured
// slot that did not resolve, is MCP_UNAVAILABLE; never a dropped client.

function tool(name: string): McpTool {
  return { name, description: name, inputSchema: {} };
}

function okClient(tools: McpTool[]): IMcpClient {
  return {
    listTools: async () => ({ ok: true as const, value: tools }),
    callTool: async () => ({ ok: true as const, value: { content: 'x' } }),
  };
}

function rejects(e: unknown): boolean {
  assert.ok(e instanceof OrchestratorError, String(e));
  assert.equal(e.code, 'MCP_UNAVAILABLE');
  return true;
}

describe('McpToolRegistry.resolve — fail loud (M4)', () => {
  it('a client whose listTools is ok:false → rejects MCP_UNAVAILABLE naming the client and its code', async () => {
    const down: IMcpClient = {
      listTools: async () => ({
        ok: false as const,
        error: new McpError('down', 'MCP_TRANSPORT'),
      }),
      callTool: async () => ({ ok: true as const, value: { content: 'x' } }),
    };
    const registry = new McpToolRegistry(
      [okClient([tool('A')]), down],
      undefined,
      {},
    );
    await assert.rejects(registry.resolve(), (e: unknown) => {
      rejects(e);
      assert.match((e as Error).message, /client 1/);
      assert.match((e as Error).message, /MCP_TRANSPORT/);
      return true;
    });
  });

  it('a client whose listTools throws → the same', async () => {
    const throwing: IMcpClient = {
      listTools: async () => {
        throw new Error('socket hang up');
      },
      callTool: async () => ({ ok: true as const, value: { content: 'x' } }),
    };
    const registry = new McpToolRegistry(
      [okClient([tool('A')]), throwing],
      undefined,
      {},
    );
    await assert.rejects(registry.resolve(), (e: unknown) => {
      rejects(e);
      assert.match((e as Error).message, /client 1/);
      assert.match((e as Error).message, /socket hang up/);
      return true;
    });
  });

  it('fewer resolved clients than configuredSlotCount → the same, naming the missing slot', async () => {
    const client = okClient([tool('A')]);
    const strategy: IMcpConnectionStrategy = {
      resolve: async () => ({
        clients: [client],
        toolsChanged: false,
        clientDescriptors: [{ slotIndex: 0, label: 'a' }],
        configuredSlotCount: 2,
      }),
    };
    const registry = new McpToolRegistry([client], strategy, {});
    await assert.rejects(registry.resolve(), (e: unknown) => {
      rejects(e);
      assert.match((e as Error).message, /slot 1/);
      return true;
    });
  });

  it('every client lists → the namespaced tools (unchanged)', async () => {
    const registry = new McpToolRegistry(
      [okClient([tool('A')]), okClient([tool('B')])],
      undefined,
      {},
    );
    const { tools } = await registry.resolve();
    assert.deepEqual(tools.map((t) => t.name).sort(), ['A', 'B']);
  });
});
