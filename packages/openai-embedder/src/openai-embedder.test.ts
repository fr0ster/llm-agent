import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OpenAiEmbedder } from './openai-embedder.js';

describe('OpenAiEmbedder — constructor', () => {
  it('throws when model is missing', () => {
    assert.throws(
      // biome-ignore lint/suspicious/noExplicitAny: intentional missing model for test
      () => new OpenAiEmbedder({ apiKey: 'test' } as any),
      /OpenAIEmbedder requires a 'model'/,
    );
  });

  it('throws when apiKey is missing', () => {
    assert.throws(
      // biome-ignore lint/suspicious/noExplicitAny: intentional missing apiKey for test
      () => new OpenAiEmbedder({ model: 'text-embedding-3-small' } as any),
      /API key is required for embedding/,
    );
  });

  it('sets model when provided', () => {
    const e = new OpenAiEmbedder({
      apiKey: 'test',
      model: 'text-embedding-3-small',
    });
    assert.equal(e.model, 'text-embedding-3-small');
  });

  it('uses custom model when provided', () => {
    const e = new OpenAiEmbedder({
      apiKey: 'test',
      model: 'text-embedding-ada-002',
    });
    assert.equal(e.model, 'text-embedding-ada-002');
  });
});
