import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LlmError,
  MODEL_CONTEXT_EXCEEDED,
  RagError,
} from '@mcp-abap-adt/llm-agent';
import { makeLlm, makeRag } from '@mcp-abap-adt/llm-agent-libs/testing';
import { makeToolsRagHandle } from '../tools-rag-handle.js';

const ok = <T>(value: T) => ({ ok: true as const, value });
function fakeClient(tools: { name: string }[]) {
  return { listTools: async () => ok(tools) } as never; // IMcpClient
}
const embedder = {} as never; // minimal IEmbedder fake

for (const thrown of [false, true]) {
  test(`tools lookup preserves ${thrown ? 'thrown' : 'returned'} context overflow and ordinary fallback`, async () => {
    const query = async (error: LlmError) => {
      let calls = 0;
      const model = makeLlm([]);
      model.chat = async () => {
        calls++;
        if (thrown) throw error;
        return { ok: false, error };
      };
      const handle = await makeToolsRagHandle(
        [],
        {
          ...makeRag([]),
          async query(embedding) {
            const result = await model.chat([
              { role: 'user', content: embedding.text },
            ]);
            if (result.ok) return { ok: true, value: [] };
            return {
              ok: false,
              error: Object.assign(new RagError('RAG query failed'), {
                cause: result.error,
              }),
            };
          },
        },
        {
          async embedQuery() {
            return { vector: [1] };
          },
        },
        undefined,
        { namespacedTools: [{ name: 'ReadOrders' }] },
      );
      return { run: () => handle.query('read orders'), calls: () => calls };
    };
    const terminal = await query(
      new LlmError('Prompt is too long', MODEL_CONTEXT_EXCEEDED),
    );
    await assert.rejects(terminal.run, { code: MODEL_CONTEXT_EXCEEDED });
    assert.equal(terminal.calls(), 1);

    const ordinary = await query(new LlmError('Unavailable'));
    if (thrown) {
      await assert.rejects(ordinary.run, /Unavailable/);
    } else {
      assert.deepEqual(await ordinary.run(), [{ name: 'ReadOrders' }]);
    }
    assert.equal(ordinary.calls(), 1);
  });
}

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

test('query(text, k, options) forwards options to toolsRag.query', async () => {
  const seen: unknown[] = [];
  const toolsRag = {
    query: async (_e: unknown, _k: number, options?: unknown) => {
      seen.push(options);
      return ok([{ metadata: { id: 'tool:A' } }]);
    },
  } as never; // IRag
  const h = await makeToolsRagHandle(
    [fakeClient([{ name: 'A' }])],
    toolsRag,
    embedder,
  );
  const options = {
    trace: { traceId: 'r1' },
    signal: new AbortController().signal,
  };
  await h.query('find A', 5, options as never);
  assert.equal(seen.length, 1);
  assert.equal(
    seen[0],
    options,
    'the strategy must see the request CallOptions',
  );
});
