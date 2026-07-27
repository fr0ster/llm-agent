import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LlmTool } from '@mcp-abap-adt/llm-agent';
import { makeToolsRagHandle } from '../tools-rag-handle.js';

const ok = <T>(value: T) => ({ ok: true as const, value });
function fakeClient(tools: { name: string }[]) {
  return { listTools: async () => ok(tools) } as never; // IMcpClient
}
const embedder = {} as never; // minimal IEmbedder fake

function namespacedTool(name: string): LlmTool {
  return { name, description: '', inputSchema: {} };
}

test('query() hits the catalog by exposed (namespaced) name when a snapshot is supplied', async () => {
  const namespacedTools = [
    namespacedTool('s0__Search'),
    namespacedTool('s1__Search'),
  ];
  const toolsRag = {
    query: async () =>
      ok([{ metadata: { id: 'tool:1:Search', name: 's1__Search' } }]),
  } as never; // IRag
  const h = await makeToolsRagHandle(
    [fakeClient([{ name: 'Search' }]), fakeClient([{ name: 'Search' }])],
    toolsRag,
    embedder,
    undefined,
    { namespacedTools },
  );
  const r = await h.query('find search', 10);
  assert.deepEqual(
    r.map((t) => t.name),
    ['s1__Search'],
  );
});

test('a stale/foreign RAG record (no matching catalog entry) is skipped without crashing', async () => {
  const namespacedTools = [namespacedTool('s0__Search')];
  const toolsRag = {
    query: async () =>
      ok([
        // A genuine hit alongside a stale/foreign record so hits.length > 0
        // and the fallback-to-full-catalog path does NOT mask the skip.
        { metadata: { id: 'tool:s0__Search', name: 's0__Search' } },
        { metadata: { id: 'tool:sX__Ghost', name: 'sX__Ghost' } },
      ]),
  } as never; // IRag
  const h = await makeToolsRagHandle(
    [fakeClient([{ name: 'Search' }])],
    toolsRag,
    embedder,
    undefined,
    { namespacedTools },
  );
  const r = await h.query('find ghost', 10);
  assert.deepEqual(
    r.map((t) => t.name),
    ['s0__Search'],
  );
});

test('no namespaced snapshot supplied → bare catalog exactly as today', async () => {
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
  assert.equal(h.lookup('A')?.name, 'A');
  assert.equal(h.lookup('s0__Search'), undefined);
});
