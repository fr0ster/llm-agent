import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type IMcpClient,
  type McpClientDescriptor,
  SimpleRagRegistry,
} from '@mcp-abap-adt/llm-agent';
import { SessionGraphFactory } from '../session-graph-factory.js';

function client(): IMcpClient {
  return {
    async listTools() {
      return { ok: true, value: [] };
    },
    async callTool() {
      return { ok: true, value: { content: [] } };
    },
  };
}

const identity = { sessionId: 'test-session', userId: 'test-user' };
const migrationMessage =
  /Multiple MCP clients require a descriptor label.*withMcpServers\(\).*named mcp: entries/;

test('bare session factory rejects multiple clients before buildAgent runs', async () => {
  let builds = 0;
  const factory = new SessionGraphFactory({
    ragRegistry: new SimpleRagRegistry(),
    toolsRag: undefined,
    mcpClientFactory: () => [client(), client()],
    buildAgent: async () => {
      builds++;
      return undefined;
    },
  });
  await assert.rejects(() => factory.build(identity), migrationMessage);
  assert.equal(builds, 0);
});

test('session factory rejects mixed or empty labels before building the agent', async () => {
  const sets: McpClientDescriptor[][] = [
    [{ slotIndex: 0, label: 'first' }, { slotIndex: 1 }],
    [{ slotIndex: 0, label: '' }],
  ];
  for (const descriptors of sets) {
    const factory = new SessionGraphFactory({
      ragRegistry: new SimpleRagRegistry(),
      toolsRag: undefined,
      mcpClientFactoryWithDescriptors: () => ({
        clients: descriptors.map(() => client()),
        clientDescriptors: descriptors,
        configuredSlotCount: descriptors.length,
      }),
      buildAgent: async () => {
        assert.fail('invalid labels must be rejected before buildAgent');
      },
    });
    await assert.rejects(() => factory.build(identity), /descriptor label/);
  }
});

test('session factory accepts labeled clients and preserves their descriptors', async () => {
  const descriptors = [
    { slotIndex: 2, label: 'second' },
    { slotIndex: 0, label: 'first' },
  ];
  const factory = new SessionGraphFactory({
    ragRegistry: new SimpleRagRegistry(),
    toolsRag: undefined,
    mcpClientFactoryWithDescriptors: () => ({
      clients: [client(), client()],
      clientDescriptors: descriptors,
      configuredSlotCount: 3,
    }),
    buildAgent: async (parts) => {
      assert.deepEqual(parts.mcpClientDescriptors, descriptors);
      return undefined;
    },
  });
  const graph = await factory.build(identity);
  await graph.dispose();
});

test('session factory accepts one unlabeled client', async () => {
  const factory = new SessionGraphFactory({
    ragRegistry: new SimpleRagRegistry(),
    toolsRag: undefined,
    mcpClientFactory: () => [client()],
    buildAgent: async () => undefined,
  });
  const graph = await factory.build(identity);
  await graph.dispose();
});
