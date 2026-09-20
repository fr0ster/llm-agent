import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
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
