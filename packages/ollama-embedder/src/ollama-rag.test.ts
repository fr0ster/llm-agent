import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  EMBEDDING_CONTEXT_EXCEEDED,
  RagError,
  TextOnlyEmbedding,
  terminalRunError,
} from '@mcp-abap-adt/llm-agent';
import { OllamaRag } from './ollama.js';

test('OllamaRag surfaces a context rejection for the full query on the first request', async (t) => {
  const prompt = 'a'.repeat(41_664);
  let calls = 0;
  t.mock.method(
    globalThis,
    'fetch',
    async (url: URL | Request | string, init?: RequestInit) => {
      if (String(url).endsWith('/api/show')) return Response.json({});
      calls++;
      assert.equal(
        init?.body,
        JSON.stringify({ model: 'test', input: [prompt], truncate: false }),
      );
      return Response.json(
        { error: 'input exceeds maximum context length' },
        { status: 400 },
      );
    },
  );
  const rag = new OllamaRag({ model: 'test' });
  const result = await rag.query(new TextOnlyEmbedding(prompt), 1);
  assert.equal(calls, 1);
  assert.equal(result.ok, false);
  assert.ok(result.error instanceof RagError);
  assert.equal(result.error.code, EMBEDDING_CONTEXT_EXCEEDED);
  assert.equal(result.error.status, 400);
  assert.equal(terminalRunError(result.error), result.error);
});

test('OllamaRag returns the first service failure without retrying', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url: URL | Request | string) => {
    if (String(url).endsWith('/api/show')) return Response.json({});
    if (++calls === 1) return new Response('unavailable', { status: 503 });
    return Response.json({ embeddings: [[1]] });
  });
  const rag = new OllamaRag({ model: 'test' });
  const result = await rag.upsert('q', {});
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'EMBED_ERROR');
  assert.equal(result.error.status, 503);
  assert.equal(calls, 1);
});
