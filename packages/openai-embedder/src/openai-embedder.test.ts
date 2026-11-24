import assert from 'node:assert/strict';
import { describe, it, test } from 'node:test';
import {
  EMBEDDING_CONTEXT_EXCEEDED,
  staticApiKey,
  terminalRunError,
} from '@mcp-abap-adt/llm-agent';
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

for (const [status, message, code, providerCode, providerType] of [
  [400, 'maximum context length must be a positive integer', 'EMBED_ERROR'],
  [
    400,
    'This model has a maximum context length of 8192 tokens',
    'EMBED_ERROR',
  ],
  [401, 'Invalid API key', 'EMBED_ERROR'],
  [429, 'Rate limited', 'EMBED_ERROR'],
  [500, 'Service failure', 'EMBED_ERROR'],
  [
    400,
    'The maximum context length is 8192 tokens. However, you requested 8193 tokens.',
    EMBEDDING_CONTEXT_EXCEEDED,
  ],
  [
    400,
    'Invalid request',
    EMBEDDING_CONTEXT_EXCEEDED,
    'context_length_exceeded',
  ],
  [
    400,
    'Requested 300500 tokens, max 300000 tokens per request',
    EMBEDDING_CONTEXT_EXCEEDED,
    'max_tokens_per_request',
    'max_tokens_per_request',
  ],
  [
    400,
    'Request rejected',
    EMBEDDING_CONTEXT_EXCEEDED,
    'max_tokens_per_request',
  ],
  [
    400,
    'Requested 300001 tokens, max 300000 tokens per request',
    EMBEDDING_CONTEXT_EXCEEDED,
  ],
  [
    400,
    'Requested 300000 tokens, max 300000 tokens per request',
    'EMBED_ERROR',
  ],
] as const) {
  test(`OpenAI preserves HTTP ${status} details for ${message}`, async (t) => {
    const body = JSON.stringify({
      error: { message, type: providerType, code: providerCode },
    });
    t.mock.method(
      globalThis,
      'fetch',
      async () => new Response(body, { status }),
    );
    const embedder = new OpenAiEmbedder({
      credential: staticApiKey('test'),
      model: 'text-embedding-3-small',
    });
    for (const [action, run] of [
      ['batch embed', () => embedder.embedBatch(['hello', 'world'])],
      ['embed', () => embedder.embed('hello')],
    ] as const) {
      await assert.rejects(run, (error) => {
        assert.ok(error instanceof Error);
        assert.equal(error.cause, undefined);
        assert.partialDeepStrictEqual(
          { ...error, message: error.message },
          {
            code,
            status,
            message: `OpenAI ${action} error: HTTP ${status} - ${body}`,
          },
        );
        if (code === EMBEDDING_CONTEXT_EXCEEDED)
          assert.equal(terminalRunError(error), error);
        return true;
      });
    }
  });
}
