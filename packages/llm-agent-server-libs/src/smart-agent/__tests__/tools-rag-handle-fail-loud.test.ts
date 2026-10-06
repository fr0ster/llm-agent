/**
 * Spec §10.5.3 M9 — the tools-RAG handle fails loud: a client that cannot list
 * its tools rejects `query` with its McpError (nothing cached), a failed store
 * query rejects with its RagError, and zero hits is an honest empty answer.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IMcpClient, IRag } from '@mcp-abap-adt/llm-agent';
import { McpError, RagError } from '@mcp-abap-adt/llm-agent';
import { makeToolsRagHandle } from '../tools-rag-handle.js';

const ok = <T>(value: T) => ({ ok: true as const, value });
const embedder = {} as never;

function switchable(tools: { name: string }[]): IMcpClient & {
  up(): void;
  lists: number;
} {
  let isDown = true;
  const c = {
    lists: 0,
    up() {
      isDown = false;
    },
    async listTools() {
      c.lists++;
      if (isDown) {
        return {
          ok: false as const,
          error: new McpError('Not connected', 'MCP_NOT_CONNECTED'),
        };
      }
      return ok(tools);
    },
  };
  return c as unknown as IMcpClient & { up(): void; lists: number };
}

test('M9: a client failing listTools → query rejects with its McpError; nothing is cached', async () => {
  const client = switchable([{ name: 'A' }]);
  const h = await makeToolsRagHandle([client], undefined, undefined);
  await assert.rejects(
    h.query('x', 5),
    (e: unknown) => e instanceof McpError && e.code === 'MCP_NOT_CONNECTED',
  );
  client.up();
  const listsBefore = client.lists;
  const r = await h.query('x', 5);
  assert.equal(client.lists, listsBefore + 1, 'listed again — no cache');
  assert.deepEqual(
    r.map((t) => t.name),
    ['A'],
  );
});

test('M9: a client that throws → query rejects with an McpError', async () => {
  const throwing = {
    listTools: async () => {
      throw new Error('boom');
    },
  } as unknown as IMcpClient;
  const h = await makeToolsRagHandle([throwing], undefined, undefined);
  await assert.rejects(h.query('x', 5), (e: unknown) => e instanceof McpError);
});

test('M9: a failed toolsRag.query → query rejects with its RagError', async () => {
  const toolsRag = {
    query: async () => ({
      ok: false as const,
      error: new RagError('open', 'CIRCUIT_OPEN'),
    }),
  } as unknown as IRag;
  const client = switchable([{ name: 'A' }]);
  client.up();
  const h = await makeToolsRagHandle([client], toolsRag, embedder);
  await assert.rejects(
    h.query('x', 5),
    (e: unknown) => e instanceof RagError && e.code === 'CIRCUIT_OPEN',
  );
});

test('M9: zero hits → [] (never the first N catalog tools)', async () => {
  const toolsRag = { query: async () => ok([]) } as unknown as IRag;
  const client = switchable([{ name: 'A' }, { name: 'B' }]);
  client.up();
  const h = await makeToolsRagHandle([client], toolsRag, embedder);
  assert.deepEqual(await h.query('x', 5), []);
});

test('a tools store configured with no embedder is queried (text-only), and its hits come back', async () => {
  const seen: { text?: string }[] = [];
  const toolsRag = {
    query: async (embedding: { text: string }) => {
      seen.push({ text: embedding.text });
      return ok([{ metadata: { id: 'tool:B' } }]);
    },
  } as unknown as IRag;
  const client = switchable([{ name: 'A' }, { name: 'B' }]);
  client.up();
  const h = await makeToolsRagHandle([client], toolsRag, undefined);
  const r = await h.query('find B', 5);
  assert.deepEqual(
    r.map((t) => t.name),
    ['B'],
  );
  assert.deepEqual(seen, [{ text: 'find B' }]);
});
