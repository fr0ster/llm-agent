import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { SmartServer } from '../smart-server.js';

// Reuses the same credential-free construction as readiness-gate.test.ts: a
// single config object with an injected fake LLM and an unreachable MCP. The
// infra routes asserted here (models / embedding-models / OPTIONS / 404) do not
// depend on readiness, so they answer identically whether MCP is up or down.
let handle: { port: number; close: () => Promise<void> };
let base: string;

before(async () => {
  const server = new SmartServer({
    port: 0,
    llm: { apiKey: 'test', model: 'test-model' },
    skipModelValidation: true,
    mcp: { type: 'http', url: 'http://127.0.0.1:7779/mcp/stream/http' },
  });
  handle = await server.start();
  base = `http://127.0.0.1:${handle.port}`;
});
after(async () => {
  await handle.close();
});

test('GET /v1/models → 200 list with smart-agent entry', async () => {
  const r = await fetch(`${base}/v1/models`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.object, 'list');
  assert.ok(Array.isArray(body.data));
  assert.ok(body.data.some((m: { id: string }) => m.id === 'smart-agent'));
});

test('GET /v1/embedding-models → 200 list', async () => {
  const r = await fetch(`${base}/v1/embedding-models`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.object, 'list');
  assert.ok(Array.isArray(body.data));
});

test('GET /v1/embedding-models?exclude_embedding=true → 200 list', async () => {
  const r = await fetch(`${base}/v1/embedding-models?exclude_embedding=true`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.object, 'list');
});

test('GET /v1/models?exclude_embedding=true → 200 list', async () => {
  const r = await fetch(`${base}/v1/models?exclude_embedding=true`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.object, 'list');
});

test('OPTIONS → 204 with CORS headers', async () => {
  const r = await fetch(`${base}/v1/chat/completions`, { method: 'OPTIONS' });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  assert.match(
    r.headers.get('access-control-allow-methods') ?? '',
    /GET, POST, PUT, OPTIONS/,
  );
});

test('unknown path → 404 with invalid_request_error', async () => {
  const r = await fetch(`${base}/no/such/route`);
  assert.equal(r.status, 404);
  const body = await r.json();
  assert.equal(body.error.type, 'invalid_request_error');
  assert.match(body.error.message, /Cannot GET \/no\/such\/route/);
});
