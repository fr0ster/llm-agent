import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  ILlm,
  IMcpClient,
  IMcpServer,
  McpClientDescriptor,
} from '@mcp-abap-adt/llm-agent';
import { testRagAccess } from '@mcp-abap-adt/llm-agent/testing/rag-access-testing';
import { SmartAgentBuilder } from '../builder.js';
import { unwrapBuilderResult } from '../builder-types.js';

const migrationMessage =
  /Multiple MCP clients require a descriptor label for every client.*withMcpClients\(\).*withMcpServers\(\).*label.*named mcp: entries/;

const llm: ILlm = {
  async chat() {
    return {
      ok: true,
      value: { content: 'ok', toolCalls: [], finishReason: 'stop' },
    };
  },
  async *streamChat() {
    yield { ok: true, value: { content: 'ok' } };
  },
};

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

function server(descriptor?: McpClientDescriptor): IMcpServer {
  return {
    descriptor,
    async start() {
      return client();
    },
    async stop() {},
  };
}

function builder(): SmartAgentBuilder {
  return new SmartAgentBuilder({ skipModelValidation: true })
    .withRagAccess(testRagAccess())
    .withMainLlm(llm);
}

test('withMcpClients fails at build time for two or more clients with migration guidance', async () => {
  for (const clients of [
    [client(), client()],
    [client(), client(), client()],
  ]) {
    const configured = builder().withMcpClients(clients);
    await assert.rejects(() => configured.build(), migrationMessage);
  }
});

test('one unlabeled client builds', async () => {
  const handle = await builder()
    .withMcpClients([client()])
    .build()
    .then(unwrapBuilderResult);
  await handle.close();
});

test('multiple labeled servers build', async () => {
  const handle = await builder()
    .withMcpServers([
      server({ slotIndex: 0, label: 'first' }),
      server({ slotIndex: 1, label: 'second' }),
    ])
    .build()
    .then(unwrapBuilderResult);
  assert.equal(handle.mcpClients.length, 2);
  await handle.close();
});

test('missing or mixed server labels fail before starting servers', async () => {
  for (const servers of [
    [server(), server()],
    [server({ slotIndex: 0, label: 'first' }), server()],
    [server({ slotIndex: 0, label: 'first' }), server({ slotIndex: 1 })],
  ]) {
    let starts = 0;
    const tracked = servers.map((entry) => ({
      ...entry,
      async start() {
        starts++;
        return entry.start();
      },
    }));
    await assert.rejects(
      () => builder().withMcpServers(tracked).build(),
      migrationMessage,
    );
    assert.equal(starts, 0);
  }
});

test('empty descriptor label fails even for one server', async () => {
  await assert.rejects(
    () =>
      builder()
        .withMcpServers([server({ slotIndex: 0, label: '' })])
        .build(),
    /descriptor label must not be empty/,
  );
});

test('unlabeled connection-strategy clients fail before listing tools', async () => {
  let lists = 0;
  const unavailable: IMcpClient = {
    ...client(),
    async listTools() {
      lists++;
      throw new Error('unavailable');
    },
  };
  await assert.rejects(
    () =>
      builder()
        .withMcpConnectionStrategy({
          async resolve() {
            return { clients: [client(), unavailable], toolsChanged: false };
          },
        })
        .build(),
    migrationMessage,
  );
  assert.equal(lists, 0);
});

test('unnamed multi-server configuration fails before connecting', async () => {
  const configured = new SmartAgentBuilder({
    skipModelValidation: true,
    mcp: [
      { type: 'http', url: 'http://localhost/first' },
      { type: 'http', url: 'http://localhost/second' },
    ],
  })
    .withRagAccess(testRagAccess())
    .withMainLlm(llm);
  await assert.rejects(() => configured.build(), migrationMessage);
});

test('named multi-server configuration and labeled strategy clients build', async () => {
  const handle = await new SmartAgentBuilder({
    skipModelValidation: true,
    mcp: [
      { type: 'http', name: 'first', url: 'http://localhost/first' },
      { type: 'http', name: 'second', url: 'http://localhost/second' },
    ],
  })
    .withRagAccess(testRagAccess())
    .withMainLlm(llm)
    .withMcpConnectionStrategy({
      async resolve() {
        return {
          clients: [client(), client()],
          clientDescriptors: [
            { slotIndex: 0, label: 'first' },
            { slotIndex: 1, label: 'second' },
          ],
          toolsChanged: false,
        };
      },
    })
    .build()
    .then(unwrapBuilderResult);
  await handle.close();
});
