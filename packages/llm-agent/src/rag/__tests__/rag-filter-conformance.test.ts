import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  conformanceEmbedder,
  ragFilterConformanceCases,
  ragOwnerFilterConformanceCases,
  ragRawOwnerConformanceCase,
  seedLegacyRagRecord,
} from '../../testing/rag-filter-conformance.js';
import { InMemoryRag } from '../in-memory-rag.js';
import { symmetricEmbedder } from '../retrieval-embedder.js';
import { VectorRag } from '../vector-rag.js';

describe('RAG identity filter conformance — InMemoryRag', () => {
  for (const c of [
    ...ragFilterConformanceCases,
    ...ragOwnerFilterConformanceCases,
  ]) {
    it(c.name, () => c.run(async () => new InMemoryRag()));
  }
});

describe('RAG identity filter conformance — VectorRag', () => {
  for (const c of [
    ...ragFilterConformanceCases,
    ...ragOwnerFilterConformanceCases,
  ]) {
    it(c.name, () =>
      c.run(
        async () => new VectorRag(symmetricEmbedder(conformanceEmbedder())),
      ),
    );
  }
});

it('InMemory shared raw conflicting-owner records are excluded and writes refused', async () => {
  const rag = new InMemoryRag();
  await ragRawOwnerConformanceCase({
    rag,
    async insertRaw(r) {
      assert.ok((await rag.upsert(r.text, { id: r.id })).ok);
      const result = await rag.getById(r.id);
      assert.ok(result.ok && result.value);
      Object.assign(result.value.metadata, r.metadata);
    },
  });
});

it('VectorRag shared raw conflicting-owner records are excluded and writes refused', async () => {
  const rag = new VectorRag(symmetricEmbedder(conformanceEmbedder()));
  await ragRawOwnerConformanceCase({
    rag,
    async insertRaw(r) {
      await seedLegacyRagRecord(rag, r.id, r.text, r.metadata);
      const result = await rag.getById(r.id);
      assert.ok(result.ok && result.value);
      Object.assign(result.value.metadata, r.metadata);
    },
  });
});
