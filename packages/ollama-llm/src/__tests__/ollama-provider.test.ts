import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OllamaProvider } from '../ollama-provider.js';

describe('OllamaProvider', () => {
  it('constructs without an apiKey (Ollama ignores it)', () => {
    const p = new OllamaProvider({ model: 'qwen2.5:14b' });
    assert.equal(p.model, 'qwen2.5:14b');
  });

  it('accepts an explicit baseURL', () => {
    const p = new OllamaProvider({
      model: 'llama3',
      baseURL: 'http://ollama.internal:11434/v1',
    });
    assert.equal(p.model, 'llama3');
  });

  it('uses default baseURL when none is provided', () => {
    const p = new OllamaProvider({ model: 'qwen2.5:14b' });
    assert.equal(p.client.defaults.baseURL, 'http://localhost:11434/v1');
  });

  it('reports no embedding models', async () => {
    const p = new OllamaProvider({ model: 'qwen2.5:14b' });
    assert.deepEqual(await p.getEmbeddingModels(), []);
  });
});
