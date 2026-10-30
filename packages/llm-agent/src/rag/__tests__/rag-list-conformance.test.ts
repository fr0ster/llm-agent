import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IRag } from '../../interfaces/rag.js';
import { conformanceEmbedder } from '../../testing/rag-filter-conformance.js';
import { ragListConformanceCases } from '../../testing/rag-list-conformance.js';
import { InMemoryRag } from '../in-memory-rag.js';
import { symmetricEmbedder } from '../retrieval-embedder.js';
import { VectorRag } from '../vector-rag.js';

for (const [name, makeStore] of [
  ['in-memory', async () => new InMemoryRag()],
  [
    'vector',
    async () => new VectorRag(symmetricEmbedder(conformanceEmbedder())),
  ],
] as const) {
  describe(`${name} listing`, () => {
    it('keeps anonymous canonical IDs distinct from caller IDs', async () => {
      const store = await makeStore();
      assert.ok((await store.upsert('anonymous text', {})).ok);
      assert.ok((await store.writer().upsertRaw('0', 'named text', {})).ok);
      const page = await store.list({ includeText: true });
      assert.ok(page.ok);
      const anonymous = page.value.records.find(
        (record) => record.text === 'anonymous text',
      );
      assert.ok(anonymous);
      assert.notEqual(anonymous.id, '0');
      const collision = await store
        .writer()
        .upsertRaw(anonymous.id, 'collision', {});
      assert.ok(!collision.ok);
      assert.equal(collision.error.code, 'INVALID_ARGUMENT');
      assert.ok((await store.upsert('anonymous text', {})).ok);
      const read = await store.getById(anonymous.id);
      assert.ok(read.ok);
      assert.equal(read.value?.text, 'anonymous text');
      const again = await store.list();
      assert.ok(again.ok);
      assert.equal(again.value.records[0].id, anonymous.id);
      assert.deepEqual(await store.writer().deleteByIdRaw(anonymous.id), {
        ok: true,
        value: true,
      });
      assert.deepEqual(await store.getById(anonymous.id), {
        ok: true,
        value: null,
      });
      const named = await store.getById('0');
      assert.ok(named.ok);
      assert.equal(named.value?.text, 'named text');
    });
    for (const test of ragListConformanceCases)
      it(test.name, () => test.run(makeStore));
  });
}

for (const makeStore of [
  async () => new InMemoryRag(),
  async () => new VectorRag(symmetricEmbedder(conformanceEmbedder())),
]) {
  it('rejects unsupported stored metadata without modifying the store', async () => {
    for (const invalid of [
      Number.POSITIVE_INFINITY,
      1n,
      () => 1,
      new Date(),
      { bad: undefined },
    ]) {
      const store = await makeStore();
      const writer = store.writer();
      const written = await writer.upsertRaw('id', 'text', { invalid });
      assert.ok(written.ok);
      const result = await store.list();
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, 'RAG_INVALID_METADATA');
    }
  });
}

// An existing custom implementation remains valid without the optional capability.
const legacyRag: IRag = {
  async query() {
    return { ok: true, value: [] };
  },
  async getById() {
    return { ok: true, value: null };
  },
  async healthCheck() {
    return { ok: true, value: undefined };
  },
};
it('listing capability narrows directly on IRag', async () => {
  assert.equal(legacyRag.list, undefined);
  const rag: IRag = new InMemoryRag();
  if (rag.list) assert.ok((await rag.list()).ok);
});
