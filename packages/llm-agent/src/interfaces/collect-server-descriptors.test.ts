import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectServerDescriptors } from './collect-server-descriptors.js';
import type {
  IMcpClient,
  McpError,
  McpTool,
  McpToolResult,
  Result,
} from './index.js';
import type { IMcpServer } from './mcp-server.js';

function stubClient(): IMcpClient {
  return {
    async listTools(): Promise<Result<McpTool[], McpError>> {
      return { ok: true, value: [] };
    },
    async callTool(): Promise<Result<McpToolResult, McpError>> {
      return { ok: true, value: { content: [] } };
    },
  } as unknown as IMcpClient;
}

function stubServer(descriptor?: {
  slotIndex: number;
  label: string;
}): IMcpServer {
  return {
    ...(descriptor ? { descriptor } : {}),
    async start(): Promise<IMcpClient> {
      return stubClient();
    },
    async stop(): Promise<void> {},
  };
}

test('no server carries a descriptor → returns undefined', () => {
  const servers = [stubServer(), stubServer()];
  const result = collectServerDescriptors(servers, 'testSeam');
  assert.equal(result, undefined);
});

test('every server carries one → returns them all, in order', () => {
  const servers = [
    stubServer({ slotIndex: 0, label: 'first' }),
    stubServer({ slotIndex: 1, label: 'second' }),
    stubServer({ slotIndex: 2, label: 'third' }),
  ];
  const result = collectServerDescriptors(servers, 'testSeam');
  assert.deepEqual(result, [
    { slotIndex: 0, label: 'first' },
    { slotIndex: 1, label: 'second' },
    { slotIndex: 2, label: 'third' },
  ]);
});

test('only some carry one → throws, and the message contains the seam name', () => {
  const servers = [
    stubServer({ slotIndex: 0, label: 'first' }),
    stubServer(),
    stubServer({ slotIndex: 2, label: 'third' }),
  ];
  assert.throws(
    () => collectServerDescriptors(servers, 'withMcpServers'),
    (err) => {
      if (!(err instanceof Error)) return false;
      return (
        err.message.includes('withMcpServers') &&
        err.message.includes('2 of 3 servers') &&
        err.message.includes('descriptors are all or none')
      );
    },
  );
});
