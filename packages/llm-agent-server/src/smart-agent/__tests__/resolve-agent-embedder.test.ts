import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IEmbedder } from '@mcp-abap-adt/llm-agent';
import { resolveAgentEmbedder } from '../resolve-agent-embedder.js';

describe('resolveAgentEmbedder', () => {
  it('returns the DI-injected embedder when present (wins over rag config)', async () => {
    const di = { embed: async () => [[0]] } as unknown as IEmbedder;
    const result = await resolveAgentEmbedder(
      { type: 'in-memory', embedder: 'ollama' },
      di,
      {},
    );
    assert.strictEqual(result, di);
  });

  it('returns undefined when there is no rag config', async () => {
    const result = await resolveAgentEmbedder(undefined, undefined, {});
    assert.equal(result, undefined);
  });

  it('returns undefined for a bare in-memory store (BM25, no embedder)', async () => {
    const result = await resolveAgentEmbedder(
      { type: 'in-memory' },
      undefined,
      {},
    );
    assert.equal(result, undefined);
  });

  it('builds an embedder from rag.embedder for YAML-only configs (#137)', async () => {
    // in-memory + explicit embedder → hybrid vector store needs an embedder.
    const result = await resolveAgentEmbedder(
      {
        type: 'in-memory',
        embedder: 'ollama',
        url: 'http://localhost:11434',
        model: 'bge-m3',
      },
      undefined,
      {},
    );
    assert.ok(result, 'expected a constructed embedder, got undefined');
    assert.equal(typeof result?.embed, 'function');
  });

  it('builds an embedder for a vector store even without explicit rag.embedder', async () => {
    // qdrant/hana/pg always use an embedder; default is ollama.
    const result = await resolveAgentEmbedder(
      { type: 'qdrant', url: 'http://localhost:6333', model: 'bge-m3' },
      undefined,
      {},
    );
    assert.ok(result, 'expected a default embedder for a vector store');
  });
});
