/**
 * Regression: `rag.embedder.maxBatchSize` is declared on SmartServerEmbedderConfig,
 * but the flat `rag:` section is resolved through an explicit allow-list
 * (resolveRagSection). A key missing from that list is silently dropped, so the
 * documented YAML override never reaches resolveEmbedder and the provider or
 * default cap is used instead — with no error to explain it.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveSmartServerConfig } from '../config.js';

/** Minimal YAML that passes validateResolvedConfig, plus the rag.embedder key under test. */
function yamlWith(rag: Record<string, unknown>) {
  return {
    llm: {
      provider: 'ollama',
      model: 'qwen2.5',
      url: 'http://localhost:11434',
    },
    rag: {
      store: { type: 'qdrant', url: 'http://localhost:6333' },
      embedder: { provider: 'ollama', model: 'bge-m3', ...rag },
    },
  };
}

describe('rag.embedder.maxBatchSize from YAML', () => {
  it('reaches the resolved config', () => {
    const cfg = resolveSmartServerConfig(
      {},
      yamlWith({ maxBatchSize: 64 }),
      {},
    );
    assert.equal(cfg.rag?.embedder?.maxBatchSize, 64);
  });

  it('stays undefined when the YAML omits it, so the provider cap wins', () => {
    const cfg = resolveSmartServerConfig({}, yamlWith({}), {});
    assert.equal(cfg.rag?.embedder?.maxBatchSize, undefined);
  });

  it('fails fast on a value that is not a positive safe integer', () => {
    for (const bad of [0, -1, 1.5, 'many']) {
      assert.throws(
        () => resolveSmartServerConfig({}, yamlWith({ maxBatchSize: bad }), {}),
        /rag\.embedder\.maxBatchSize/,
        `expected a config error for ${JSON.stringify(bad)}`,
      );
    }
  });
});
