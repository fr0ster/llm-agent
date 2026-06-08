import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IEmbedder } from '@mcp-abap-adt/llm-agent';
import {
  resolveAgentEmbedder,
  resolveToolsStoreEmbedder,
} from '../resolve-agent-embedder.js';

describe('resolveAgentEmbedder', () => {
  it('returns the DI-injected embedder when present (wins over rag config)', async () => {
    const di = {
      embed: async () => ({ vector: [42] }),
    } as unknown as IEmbedder;
    const result = await resolveAgentEmbedder(
      { type: 'in-memory', embedder: 'ollama' },
      di,
      {},
    );
    // The DI embedder wins over rag config — it is wrapped (UsageLoggingEmbedder)
    // for usage accounting, so identity differs but it delegates to di.
    assert.ok(result);
    assert.deepEqual((await result.embed('x')).vector, [42]);
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

describe('resolveToolsStoreEmbedder (#141: pipeline.rag.tools sharing)', () => {
  it('reuses the existing agent embedder when present (flat path / DI already resolved)', async () => {
    const current = { embed: async () => [[0]] } as unknown as IEmbedder;
    const result = await resolveToolsStoreEmbedder(
      current,
      // store config that WOULD build a different embedder — must be ignored.
      { type: 'in-memory', embedder: 'ollama', model: 'bge-m3' },
      undefined,
      {},
    );
    assert.strictEqual(
      result,
      current,
      'must not rebuild when an embedder already exists',
    );
  });

  it('builds from the tools store config for YAML-only multi-store (no flat rag, no DI)', async () => {
    const result = await resolveToolsStoreEmbedder(
      undefined,
      {
        type: 'in-memory',
        embedder: 'ollama',
        url: 'http://localhost:11434',
        model: 'bge-m3',
      },
      undefined,
      {},
    );
    assert.ok(result, 'expected a constructed embedder for the tools store');
    assert.equal(typeof result?.embed, 'function');
  });

  it('stays undefined for a bare in-memory (BM25) tools store', async () => {
    const result = await resolveToolsStoreEmbedder(
      undefined,
      { type: 'in-memory' },
      undefined,
      {},
    );
    assert.equal(result, undefined);
  });

  it('honors the DI embedder when there is no current embedder yet', async () => {
    const di = {
      embed: async () => ({ vector: [7] }),
    } as unknown as IEmbedder;
    const result = await resolveToolsStoreEmbedder(
      undefined,
      { type: 'in-memory', embedder: 'ollama', model: 'bge-m3' },
      di,
      {},
    );
    // DI embedder must win over store config (wrapped for usage accounting).
    assert.ok(result);
    assert.deepEqual((await result.embed('x')).vector, [7]);
  });
});
