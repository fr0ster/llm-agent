import assert from 'node:assert/strict';
import { describe, it, test } from 'node:test';
import { staticApiKey } from '@mcp-abap-adt/llm-agent';
import { OpenAiEmbedder } from './openai-embedder.js';

describe('OpenAiEmbedder — constructor', () => {
  it('throws when model is missing', () => {
    assert.throws(
      // biome-ignore lint/suspicious/noExplicitAny: intentional missing model for test
      () => new OpenAiEmbedder({ credential: staticApiKey('test') } as any),
      /OpenAIEmbedder requires a 'model'/,
    );
  });

  it('throws when credential is missing', () => {
    // Task B4 replaced `apiKey: string` with a required `credential`, so
    // there is no longer a field to leave empty; the absence is normally a
    // compile error. This asserts the runtime fallback for a caller that
    // bypasses the type (plain JS, or `as any`) still refuses to construct.
    assert.throws(
      // biome-ignore lint/suspicious/noExplicitAny: intentional missing credential for test
      () => new OpenAiEmbedder({ model: 'text-embedding-3-small' } as any),
      /API key is required for embedding/,
    );
  });

  it('sets model when provided', () => {
    const e = new OpenAiEmbedder({
      credential: staticApiKey('test'),
      model: 'text-embedding-3-small',
    });
    assert.equal(e.model, 'text-embedding-3-small');
  });

  it('uses custom model when provided', () => {
    const e = new OpenAiEmbedder({
      credential: staticApiKey('test'),
      model: 'text-embedding-ada-002',
    });
    assert.equal(e.model, 'text-embedding-ada-002');
  });
});

for (const [status, message] of [
  [400, 'context length must be a positive integer'],
  [400, 'This model does not support the context window parameter'],
  [400, 'maximum context length must be a positive integer'],
  [400, 'This model does not support the maximum context length parameter'],
  [401, 'Invalid API key'],
  [429, 'Rate limited'],
  [500, 'Upstream rejected request'],
] as const) {
  test(`OpenAI preserves EMBED_ERROR for HTTP ${status}: ${message}`, async (t) => {
    t.mock.method(globalThis, 'fetch', async () =>
      Response.json({ error: { message } }, { status }),
    );
    const embedder = new OpenAiEmbedder({
      credential: staticApiKey('test'),
      model: 'text-embedding-3-small',
    });
    await assert.rejects(embedder.embed('hello'), {
      code: 'EMBED_ERROR',
      status,
    });
    await assert.rejects(embedder.embedBatch(['hello', 'world']), {
      code: 'EMBED_ERROR',
      status,
    });
  });
}

test('OpenAI reports the requested token count exceeding the context length', async (t) => {
  const message =
    "This model's maximum context length is 8192 tokens. However, you requested 8193 tokens (8193 in your prompt; 0 for the completion). Please reduce your prompt; or completion length.";
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ error: { message } }, { status: 400 }),
  );
  const embedder = new OpenAiEmbedder({
    credential: staticApiKey('test'),
    model: 'text-embedding-3-small',
  });
  await assert.rejects(embedder.embed('hello'), {
    code: 'EMBEDDING_CONTEXT_EXCEEDED',
    status: 400,
  });
});
