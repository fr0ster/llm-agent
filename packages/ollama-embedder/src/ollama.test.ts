import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OllamaEmbedder } from './ollama.js';

describe('OllamaEmbedder — constructor', () => {
  it('throws when model is missing', () => {
    assert.throws(
      // biome-ignore lint/suspicious/noExplicitAny: intentional missing model for test
      () => new OllamaEmbedder({} as any),
      /OllamaEmbedder requires a 'model'/,
    );
  });

  it('sets model when provided', () => {
    const e = new OllamaEmbedder({ model: 'bge-m3' });
    assert.equal(e.model, 'bge-m3');
  });

  it('uses custom ollamaUrl when provided', () => {
    const e = new OllamaEmbedder({
      model: 'bge-m3',
      ollamaUrl: 'http://remote:11434',
    });
    assert.equal(e.model, 'bge-m3');
  });
});
