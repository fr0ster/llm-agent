import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  conformanceEmbedder,
  ragFilterConformanceCases,
  ragGetByIdScopeCase,
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
    ragGetByIdScopeCase,
    ...ragOwnerFilterConformanceCases,
  ]) {
    it(c.name, () => c.run(async () => new InMemoryRag()));
  }
});

describe('RAG identity filter conformance — VectorRag', () => {
  for (const c of [
    ...ragFilterConformanceCases,
    ragGetByIdScopeCase,
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

for (const rag of [
  new InMemoryRag({ namespace: 'native' }),
  new VectorRag(symmetricEmbedder(conformanceEmbedder()), {
    namespace: 'native',
  }),
]) {
  it(`${rag.constructor.name} getById cannot cross the store namespace`, async () => {
    const writer = rag.writer();
    assert.ok(
      (await writer.upsertRaw('id', 'example', { namespace: 'native' })).ok,
    );
    const own = await rag.getById('id');
    assert.ok(own.ok && own.value);
    // The in-memory stores expose stored metadata, including on legacy rows.
    own.value.metadata.namespace = 'foreign';
    assert.deepEqual(await rag.getById('id'), { ok: true, value: null });
    assert.deepEqual(
      await rag.getById('id', { ragFilter: { namespace: 'foreign' } }),
      { ok: true, value: null },
    );
  });
}
