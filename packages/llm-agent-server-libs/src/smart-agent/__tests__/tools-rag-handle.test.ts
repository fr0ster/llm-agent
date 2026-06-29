import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeToolsRagHandle } from '../tools-rag-handle.js';

const ok = <T>(value: T) => ({ ok: true as const, value });
function fakeClient(tools: { name: string }[]) {
  return { listTools: async () => ok(tools) } as never; // IMcpClient
}
const embedder = {} as never; // minimal IEmbedder fake

test('lookup() returns a catalog tool after eager load', async () => {
  const h = await makeToolsRagHandle(
    [fakeClient([{ name: 'GetProgram' }])],
    undefined,
    undefined,
  );
  assert.equal(h.lookup('GetProgram')?.name, 'GetProgram');
  assert.equal(h.lookup('Missing'), undefined);
});

test('query() with no RAG/embedder returns catalog slice (capped by k)', async () => {
  const h = await makeToolsRagHandle(
    [fakeClient([{ name: 'A' }, { name: 'B' }, { name: 'C' }])],
    undefined,
    undefined,
  );
  const r = await h.query('anything', 2);
  assert.deepEqual(
    r.map((t) => t.name),
    ['A', 'B'],
  );
});

test('query() filters catalog by RAG hits (tool:Name:... ids)', async () => {
  const toolsRag = {
    query: async () => ok([{ metadata: { id: 'tool:B:hash' } }]),
  } as never; // IRag
  const h = await makeToolsRagHandle(
    [fakeClient([{ name: 'A' }, { name: 'B' }])],
    toolsRag,
    embedder,
  );
  const r = await h.query('find B', 10);
  assert.deepEqual(
    r.map((t) => t.name),
    ['B'],
  );
});

test('query() falls back to catalog slice when RAG returns 0 hits', async () => {
  const toolsRag = { query: async () => ok([]) } as never; // IRag
  const h = await makeToolsRagHandle(
    [fakeClient([{ name: 'A' }])],
    toolsRag,
    embedder,
  );
  const r = await h.query('x', 10);
  assert.deepEqual(
    r.map((t) => t.name),
    ['A'],
  );
});

test('eager catalog-load failure is swallowed; lookup() returns undefined', async () => {
  const throwing = {
    listTools: async () => {
      throw new Error('boom');
    },
  } as never;
  const h = await makeToolsRagHandle([throwing], undefined, undefined);
  assert.equal(h.lookup('anything'), undefined);
});
