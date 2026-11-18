import assert from 'node:assert/strict';
import { test } from 'node:test';
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
  await assert.rejects(
    embedder.embed(oversized),
    /input length exceeds the context length/,
  );
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
