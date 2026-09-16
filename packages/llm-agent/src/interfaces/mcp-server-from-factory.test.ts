import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  IMcpClient,
  McpConnectionConfig,
  McpError,
  McpTool,
  McpToolResult,
  Result,
} from './index.js';
import { mcpServerFromFactory } from './mcp-server-from-factory.js';

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

const config: McpConnectionConfig = { type: 'stdio', command: 'echo' };

test('start() calls the factory once and returns its client', async () => {
  const client = stubClient();
  let calls = 0;
  const server = mcpServerFromFactory(async (cfg) => {
    calls++;
    assert.equal(cfg, config);
    return { client };
  }, config);

  assert.equal(await server.start(), client);
  assert.equal(calls, 1);
});

test('stop() calls the close the factory returned', async () => {
  let closed = 0;
  const server = mcpServerFromFactory(
    async () => ({
      client: stubClient(),
      close: () => {
        closed++;
      },
    }),
    config,
  );

  await server.start();
  await server.stop();
  assert.equal(closed, 1);
});

test('stop() before start() is a no-op, and stop() is idempotent', async () => {
  let closed = 0;
  const server = mcpServerFromFactory(
    async () => ({
      client: stubClient(),
      close: async () => {
        closed++;
      },
    }),
    config,
  );

  await server.stop();
  assert.equal(closed, 0);

  await server.start();
  await server.stop();
  await server.stop();
  assert.equal(closed, 1);
});

test('start() twice throws rather than leaking the first client', async () => {
  const server = mcpServerFromFactory(
    async () => ({ client: stubClient() }),
    config,
  );

  await server.start();
  await assert.rejects(() => server.start(), /already started/);
});

test('the adapter is single-use: start() after stop() throws', async () => {
  const server = mcpServerFromFactory(
    async () => ({ client: stubClient() }),
    config,
  );

  await server.start();
  await server.stop();
  // `IMcpServer` says an implementation that cannot be restarted throws.
  // This one cannot: reconnection is `IMcpConnectionStrategy`'s job.
  await assert.rejects(() => server.start(), /already stopped/);
});

test('the descriptor is carried through untouched', () => {
  const server = mcpServerFromFactory(
    async () => ({ client: stubClient() }),
    config,
    { slotIndex: 2, label: 'abap' },
  );

  assert.deepEqual(server.descriptor, { slotIndex: 2, label: 'abap' });
});
