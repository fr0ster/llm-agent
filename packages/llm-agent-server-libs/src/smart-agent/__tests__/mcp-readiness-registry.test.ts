import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IMcpClient } from '@mcp-abap-adt/llm-agent';
import { McpReadinessRegistry } from '../mcp-readiness-registry.js';

const liveClient = () =>
  ({
    listTools: async () => ({ ok: true, value: [] }),
  }) as unknown as IMcpClient;

test('empty registry (no MCP configured) is healthy', () => {
  assert.equal(new McpReadinessRegistry().allHealthy(), true);
});

test('a configured-but-unconnected target is NOT healthy', () => {
  const r = new McpReadinessRegistry();
  r.addTarget('global-0', { url: 'http://down:1/mcp' }, 'global');
  assert.equal(r.allHealthy(), false);
});

test('marking the only slot healthy makes the registry healthy', () => {
  const r = new McpReadinessRegistry();
  r.addTarget('global-0', { url: 'http://x/mcp' }, 'global');
  r.markHealthy('global-0', liveClient());
  assert.equal(r.allHealthy(), true);
});

test('a live DI client registers healthy', () => {
  const r = new McpReadinessRegistry();
  r.addLiveClient('worker-a', liveClient(), 'worker');
  assert.equal(r.allHealthy(), true);
});

test('addTarget is idempotent on id (no double-registration)', () => {
  const r = new McpReadinessRegistry();
  r.addTarget('worker:analyst:0', { url: 'http://x/mcp' }, 'worker');
  r.markHealthy('worker:analyst:0', liveClient());
  // Re-adding the same id (per-session rebuild path) must NOT reset the slot.
  r.addTarget('worker:analyst:0', { url: 'http://x/mcp' }, 'worker');
  assert.equal(r.list().length, 1, 'one slot only');
  assert.equal(r.allHealthy(), true, 'stays healthy (not reset to down)');
});

test('liveClients() returns only healthy GLOBAL clients', () => {
  const r = new McpReadinessRegistry();
  r.addLiveClient('g0', liveClient(), 'global');
  r.addLiveClient('w0', liveClient(), 'worker'); // worker excluded
  r.addTarget('g1', { url: 'http://down/mcp' }, 'global'); // down excluded
  assert.equal(r.liveClients().length, 1);
});
