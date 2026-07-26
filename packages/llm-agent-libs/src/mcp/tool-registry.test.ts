import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IMcpClient, McpTool } from '@mcp-abap-adt/llm-agent';
import type { IMcpConnectionStrategy } from '../interfaces/mcp-connection-strategy.js';
import { McpToolRegistry } from './tool-registry.js';

function makeTool(name: string): McpTool {
  return { name, description: `desc ${name}`, inputSchema: {} };
}

function makeClient(tools: McpTool[]): IMcpClient {
  const calls: Array<{ name: string; args: unknown }> = [];
  return {
    listTools: async () => ({ ok: true as const, value: tools }),
    callTool: async (name: string, args: unknown) => {
      calls.push({ name, args });
      return { ok: true as const, value: { content: [] } };
    },
    __calls: calls,
  } as unknown as IMcpClient & {
    __calls: Array<{ name: string; args: unknown }>;
  };
}

describe('McpToolRegistry.resolve() namespacing', () => {
  it('namespaces colliding tool names across two clients and routes calls to the right server with the original name', async () => {
    const client0 = makeClient([makeTool('Search')]);
    const client1 = makeClient([makeTool('Search')]);
    const registry = new McpToolRegistry([client0, client1], undefined, {});

    const { tools, toolClientMap } = await registry.resolve();

    assert.deepEqual(tools.map((t) => t.name).sort(), [
      's0__Search',
      's1__Search',
    ]);
    assert.equal(toolClientMap.size, 2);

    const routed1 = toolClientMap.get('s1__Search');
    assert.ok(routed1);
    await routed1?.callTool('s1__Search', { q: 'x' });
    const calls1 = (client1 as unknown as { __calls: Array<{ name: string }> })
      .__calls;
    assert.equal(calls1.length, 1);
    assert.equal(calls1[0].name, 'Search');
    // Never reached client0.
    const calls0 = (client0 as unknown as { __calls: Array<{ name: string }> })
      .__calls;
    assert.equal(calls0.length, 0);
  });

  it('leaves a single-client registry unchanged (bare name, value === real client)', async () => {
    const client = makeClient([makeTool('Search')]);
    const registry = new McpToolRegistry([client], undefined, {});

    const { tools, toolClientMap } = await registry.resolve();

    assert.deepEqual(
      tools.map((t) => t.name),
      ['Search'],
    );
    assert.equal(toolClientMap.get('Search'), client);
  });

  it('fails fast when a custom connection strategy returns malformed clientDescriptors', async () => {
    const client = makeClient([makeTool('Search')]);
    const strategy: IMcpConnectionStrategy = {
      resolve: async () => ({
        clients: [client],
        toolsChanged: false,
        // length mismatch: 2 descriptors for 1 client.
        clientDescriptors: [{ slotIndex: 0 }, { slotIndex: 1 }],
      }),
    } as unknown as IMcpConnectionStrategy;
    const registry = new McpToolRegistry([client], strategy, {});

    await assert.rejects(() => registry.resolve());
  });
});
