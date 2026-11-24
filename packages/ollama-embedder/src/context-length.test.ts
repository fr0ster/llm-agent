import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  EMBEDDING_CONTEXT_EXCEEDED,
  terminalRunError,
} from '@mcp-abap-adt/llm-agent';
import { OllamaEmbedder, OllamaRag } from './ollama.js';

test('uses the cached model context for each request and disables truncation', async (t) => {
  let shows = 0;
  const payloads: Array<{
    model: string;
    input: string[];
    options: { num_ctx: number };
    truncate: boolean;
  }> = [];
  t.mock.method(
    globalThis,
    'fetch',
    async (url: URL | Request | string, init?: RequestInit) => {
      if (String(url).endsWith('/api/show')) {
        shows++;
        assert.deepEqual(JSON.parse(String(init?.body)), { model: 'bge-m3' });
        return Response.json({
          model_info: {
            'general.architecture': 'bert',
            'other.context_length': 512,
            'bert.context_length': 8192,
          },
        });
      }
      assert.match(String(url), /\/api\/embed$/);
      const body: (typeof payloads)[number] = JSON.parse(String(init?.body));
      payloads.push(body);
      if (body.input.some((text) => Buffer.byteLength(text) > 8190)) {
        return Response.json(
          { error: 'the input length exceeds the context length' },
          { status: 400 },
        );
      }
      return Response.json({ embeddings: body.input.map(() => [1, 0]) });
    },
  );

  const embedder = new OllamaEmbedder({ model: 'bge-m3' });
  assert.deepEqual(
    await Promise.all([
      embedder.getMaxInputChars(),
      embedder.getMaxInputChars(),
    ]),
    [2047, 2047],
  );
  await embedder.embed('test');
  await embedder.embedBatch(['one', 'two']);
  const oversized = 'x'.repeat(8191);
  await assert.rejects(embedder.embed(oversized), (error) => {
    assert.match(String(error), /input length exceeds the context length/);
    assert.equal(terminalRunError(error)?.code, EMBEDDING_CONTEXT_EXCEEDED);
    return true;
  });
  assert.equal(shows, 1);
  assert.deepEqual(
    payloads.map((body) => body.input),
    [['test'], ['one', 'two'], [oversized]],
  );
  assert.ok(
    payloads.every(
      (body) => body.options.num_ctx === 8192 && body.truncate === false,
    ),
  );

  const rag = new OllamaRag({ model: 'bge-m3' });
  const artifact = '# Artifact\n\n'.repeat(2500);
  const upsert = await rag.upsert(artifact, { id: 'artifact' });
  assert.ok(upsert.ok);
  const fragments = payloads.at(-1)?.input ?? [];
  assert.ok(fragments.length > 1);
  assert.equal(fragments.join(''), artifact);
  const stored = await rag.getById('artifact');
  assert.ok(stored.ok);
  assert.equal(stored.value?.text, artifact);
  assert.equal(shows, 2);
});

for (const [status, message] of [
  [400, 'context length must be a positive integer'],
  [401, 'Unauthorized'],
  [429, 'Rate limited'],
  [500, 'Service failure'],
] as const) {
  test(`Ollama preserves EMBED_ERROR for HTTP ${status}`, async (t) => {
    const body = JSON.stringify({ error: message });
    t.mock.method(globalThis, 'fetch', async (url: URL | Request | string) =>
      String(url).endsWith('/api/show')
        ? Response.json({})
        : new Response(body, { status }),
    );
    const embedder = new OllamaEmbedder({ model: 'bge-m3' });
    for (const [action, run] of [
      ['embed', () => embedder.embed('hello')],
      ['batch embed', () => embedder.embedBatch(['hello', 'world'])],
    ] as const) {
      await assert.rejects(run, (error) => {
        assert.ok(error instanceof Error);
        assert.equal(error.cause, undefined);
        assert.partialDeepStrictEqual(
          { ...error, message: error.message },
          {
            code: 'EMBED_ERROR',
            message: `Ollama ${action} error: HTTP ${status} - ${body}`,
            status,
          },
        );
        return true;
      });
    }
  });
}

test('the character capacity leaves room for byte fallback and special tokens on Unicode fragments', async (t) => {
  const context = 34;
  const inputs: string[] = [];
  t.mock.method(
    globalThis,
    'fetch',
    async (url: URL | Request | string, init?: RequestInit) => {
      if (String(url).endsWith('/api/show')) {
        return Response.json({
          model_info: { 'bert.context_length': context },
        });
      }
      const body = JSON.parse(String(init?.body)) as {
        input: string[];
        truncate: boolean;
      };
      assert.equal(body.truncate, false);
      for (const fragment of body.input) {
        assert.ok(Buffer.byteLength(fragment, 'utf8') + 2 <= context);
        inputs.push(fragment);
      }
      return Response.json({ embeddings: body.input.map(() => [1, 0]) });
    },
  );
  const embedder = new OllamaEmbedder({ model: 'bge-m3' });
  assert.equal(await embedder.getMaxInputChars(), 8);
  const emoji = '\u{1f600}';
  const text = emoji.repeat(9) + '\u6f22\u5b57'.repeat(9);
  const rag = new OllamaRag({ model: 'bge-m3' });
  assert.ok((await rag.upsert(text, { id: 'unicode' })).ok);
  assert.equal(inputs[0], emoji.repeat(8));
  assert.equal(inputs.join(''), text);
});

test('a context below the byte-fallback minimum cannot declare a safe character capacity', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ model_info: { 'bert.context_length': 5 } }),
  );
  await assert.rejects(
    new OllamaEmbedder({ model: 'bge-m3' }).getMaxInputChars(),
    /cannot fit one Unicode code point/,
  );
});
