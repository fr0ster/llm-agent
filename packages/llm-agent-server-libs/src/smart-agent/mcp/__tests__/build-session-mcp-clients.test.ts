import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSessionMcpClients } from '../build-session-mcp-clients.js';

const httpCfg = {
  type: 'http' as const,
  url: 'http://localhost:9999/mcp/stream/http',
};

test('returns IMcpClient[] with a close fn; no connect at build (lazy)', () => {
  const a = buildSessionMcpClients(httpCfg);
  assert.equal(a.clients.length, 1);
  assert.equal(typeof a.clients[0].listTools, 'function');
  assert.equal(typeof a.clients[0].callTool, 'function');
  assert.equal(typeof a.close, 'function');
});

test('each call returns DISTINCT client instances (per-session isolation)', () => {
  const a = buildSessionMcpClients(httpCfg);
  const b = buildSessionMcpClients(httpCfg);
  assert.notEqual(a.clients[0], b.clients[0]);
});

test('undefined/empty config → empty clients and a no-op close', async () => {
  const a = buildSessionMcpClients(undefined);
  assert.deepEqual(a.clients, []);
  await a.close(); // must not throw
});

test('close() disconnects each built wrapper', async () => {
  // array form → two servers
  const r = buildSessionMcpClients([
    httpCfg,
    { type: 'stdio' as const, command: 'echo' },
  ]);
  assert.equal(r.clients.length, 2);
  await r.close(); // idempotent on un-connected wrappers — must not throw
});
