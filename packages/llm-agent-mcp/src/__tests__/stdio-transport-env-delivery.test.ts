/**
 * Pins the line `stdio-env.test.ts` does not reach: the actual spread of
 * `config.env` into `new StdioClientTransport({ ... })` in
 * `MCPClientWrapper.connect()` (client.ts, stdio branch). The mapper test
 * only proves `McpConnectionConfig.env` survives `toMcpClientWrapperConfig`;
 * this proves the wrapper actually hands it to the spawned child.
 *
 * Uses a REAL child process (a tiny MCP stdio server fixture) rather than a
 * mock of the SDK transport, so a refactor that silently drops the spread
 * cannot pass by construction.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MCPClientWrapper } from '../client.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, 'fixtures/stdio-echo-env-server.mjs');

test('MCPClientWrapper.connect() delivers config.env to the spawned stdio child', async () => {
  const wrapper = new MCPClientWrapper({
    transport: 'stdio',
    command: process.execPath,
    args: [FIXTURE],
    env: { PROBE_ENV_VALUE: 'per-caller-token' },
  });

  try {
    await wrapper.connect();
    const tools = await wrapper.listTools();
    assert.deepEqual(
      tools.map((t) => t.name),
      ['probe-per-caller-token'],
      'the child must have seen PROBE_ENV_VALUE — proof config.env reached the spawned process, not just the pure config mapper',
    );
  } finally {
    await wrapper.disconnect();
  }
});

test('MCPClientWrapper.connect() without env still starts the child (host defaults only)', async () => {
  const wrapper = new MCPClientWrapper({
    transport: 'stdio',
    command: process.execPath,
    args: [FIXTURE],
  });

  try {
    await wrapper.connect();
    const tools = await wrapper.listTools();
    assert.deepEqual(
      tools.map((t) => t.name),
      ['probe-missing'],
    );
  } finally {
    await wrapper.disconnect();
  }
});
