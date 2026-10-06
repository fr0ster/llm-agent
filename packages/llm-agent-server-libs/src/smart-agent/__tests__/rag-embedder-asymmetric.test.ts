import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveSmartServerConfig } from '../config.js';

const llm = { provider: 'ollama', model: 'qwen2.5' };
const withEmbedder = (embedder: Record<string, unknown>) =>
  resolveSmartServerConfig(
    {},
    {
      llm,
      rag: { store: { type: 'in-memory' }, embedder },
    },
  );

describe('rag.embedder.asymmetric', () => {
  it('is kept for sap-ai-core, also from a ${VAR} string', () => {
    for (const asymmetric of [true, 'true']) {
      const cfg = withEmbedder({
        provider: 'sap-ai-core',
        model: 'nvidia--llama-3.2-nv-embedqa-1b',
        asymmetric,
      });
      const embedder = cfg.rag?.embedder as
        | { asymmetric?: boolean }
        | undefined;
      assert.equal(embedder?.asymmetric, true);
    }
  });

  it('is refused on a provider without a document/query pair', () => {
    assert.throws(
      () =>
        withEmbedder({
          provider: 'openai',
          model: 'text-embedding-3-small',
          asymmetric: true,
        }),
      /asymmetric: supported for provider sap-ai-core only, not "openai"/,
    );
  });

  it('is refused with the foundation-models scenario', () => {
    assert.throws(
      () =>
        withEmbedder({
          provider: 'sap-ai-core',
          model: 'm',
          scenario: 'foundation-models',
          asymmetric: true,
        }),
      /needs scenario 'orchestration'/,
    );
  });

  it('is refused when it is not a boolean', () => {
    assert.throws(
      () =>
        withEmbedder({
          provider: 'sap-ai-core',
          model: 'm',
          asymmetric: 'yes',
        }),
      /rag\.embedder\.asymmetric must be true or false, got "yes"/,
    );
  });

  it('is refused beside a factory', () => {
    assert.throws(
      () => withEmbedder({ factory: 'mine', asymmetric: true }),
      /rag\.embedder\.asymmetric: not read for a factory/,
    );
  });
});
