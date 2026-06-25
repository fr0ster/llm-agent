import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IMcpClient } from '@mcp-abap-adt/llm-agent';
import { McpError } from '@mcp-abap-adt/llm-agent';
import { McpReadinessMonitor } from '../mcp-readiness-monitor.js';
import { McpReadinessRegistry } from '../mcp-readiness-registry.js';

const healthy = {
  healthCheck: async () => ({ ok: true as const, value: true }),
} as unknown as IMcpClient;

test('tick: a down target reconnects and becomes ready', async () => {
  const reg = new McpReadinessRegistry();
  reg.addTarget('g0', { url: 'http://x/mcp' }, 'global');
  const monitor = new McpReadinessMonitor(reg, {
    connect: async () => healthy,
    cooldownMs: 0,
  });
  assert.equal(monitor.isReady(), false);
  await monitor.tick();
  assert.equal(monitor.isReady(), true);
});

test('tick: a live client that fails healthCheck flips NOT ready', async () => {
  const reg = new McpReadinessRegistry();
  const flaky = {
    healthCheck: async () => ({
      ok: false as const,
      error: new McpError('Not connected', 'MCP_NOT_CONNECTED'),
    }),
  } as unknown as IMcpClient;
  reg.addLiveClient('w', flaky, 'worker');
  const monitor = new McpReadinessMonitor(reg, {
    connect: async () => {
      throw new Error('still down');
    },
    cooldownMs: 0,
  });
  assert.equal(monitor.isReady(), true);
  await monitor.tick();
  assert.equal(monitor.isReady(), false);
});

test('tick: a live client WITHOUT healthCheck stays ready (assumed healthy)', async () => {
  const reg = new McpReadinessRegistry();
  reg.addLiveClient(
    'di',
    {
      listTools: async () => ({ ok: true, value: [] }),
    } as unknown as IMcpClient,
    'global',
  );
  const monitor = new McpReadinessMonitor(reg, {
    connect: async () => {
      throw new Error('n/a');
    },
    cooldownMs: 0,
  });
  assert.equal(monitor.isReady(), true);
  await monitor.tick();
  assert.equal(monitor.isReady(), true);
});

test('tick: a GLOBAL DOWN→UP recovery fires onGlobalRecovered once', async () => {
  const reg = new McpReadinessRegistry();
  reg.addTarget('g0', { url: 'http://x/mcp' }, 'global');
  let recovered = 0;
  const monitor = new McpReadinessMonitor(reg, {
    connect: async () => healthy,
    onGlobalRecovered: async () => {
      recovered++;
    },
    cooldownMs: 0,
  });
  await monitor.tick(); // down→up
  await monitor.tick(); // stays up (healthCheck ok) → no second fire
  assert.equal(recovered, 1);
});

test('tick: a WORKER DOWN→UP recovery fires onWorkerRecovered with the id', async () => {
  const reg = new McpReadinessRegistry();
  reg.addTarget('worker:analyst:0', { url: 'http://x/mcp' }, 'worker');
  const ids: string[] = [];
  const monitor = new McpReadinessMonitor(reg, {
    connect: async () => healthy,
    onWorkerRecovered: (id) => ids.push(id),
    cooldownMs: 0,
  });
  await monitor.tick();
  assert.deepEqual(ids, ['worker:analyst:0']);
});
