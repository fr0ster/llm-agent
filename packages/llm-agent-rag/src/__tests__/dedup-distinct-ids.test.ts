import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IRag } from '@mcp-abap-adt/llm-agent';
import { symmetricEmbedder } from '@mcp-abap-adt/llm-agent';
import { conformanceEmbedder } from '@mcp-abap-adt/llm-agent/testing/rag-filter-conformance';
import { InMemoryRag } from '../in-memory-rag.js';
import { VectorRag } from '../vector-rag.js';

// Similarity dedup must never merge two records that carry different ids: a
// record with an id is replaced only by a write with the same id. Before, the
// tool record ReadFunctionInclude was overwritten by the near-identical
// ReadFunctionGroup and vanished from the catalog.

const A = 'Tool: ReadFunctionGroup — read ABAP function group source';
const B = 'Tool: ReadFunctionInclude — read ABAP function include source';

async function allIds(rag: IRag): Promise<string[]> {
  const e = conformanceEmbedder();
  const res = await rag.query(
    { text: A, toVector: async () => (await e.embed(A)).vector },
    100,
  );
  if (!res.ok) throw res.error;
  return res.value.map((r) => String(r.metadata.id)).sort();
}

const stores: Array<[string, () => IRag]> = [
  ['InMemoryRag', () => new InMemoryRag({ dedupThreshold: 0.5 })],
  [
    'VectorRag',
    () =>
      new VectorRag(symmetricEmbedder(conformanceEmbedder()), {
        dedupThreshold: 0.5,
      }),
  ],
];

for (const [name, make] of stores) {
  describe(`${name} dedup keeps records with different ids apart`, () => {
    it('two near-identical texts with distinct ids are both kept', async () => {
      const rag = make();
      const w = rag.writer?.();
      assert.ok(w);
      await w.upsertRaw('tool:ReadFunctionGroup', A, {});
      await w.upsertRaw('tool:ReadFunctionInclude', B, {});
      assert.deepEqual(await allIds(rag), [
        'tool:ReadFunctionGroup',
        'tool:ReadFunctionInclude',
      ]);
      const g = await rag.getById?.('tool:ReadFunctionGroup');
      assert.equal(g?.ok && g.value?.text, A);
    });

    it('the same id replaces the record', async () => {
      const rag = make();
      const w = rag.writer?.();
      assert.ok(w);
      await w.upsertRaw('tool:X', A, {});
      await w.upsertRaw('tool:X', B, {});
      assert.deepEqual(await allIds(rag), ['tool:X']);
      const x = await rag.getById?.('tool:X');
      assert.equal(x?.ok && x.value?.text, B);
    });

    it('a record written without an id never overwrites one that has an id', async () => {
      const rag = make();
      const w = rag.writer?.();
      assert.ok(w);
      await w.upsertRaw('tool:ReadFunctionGroup', A, {});
      await rag.upsert(B, {});
      const e = conformanceEmbedder();
      const res = await rag.query(
        { text: A, toVector: async () => (await e.embed(A)).vector },
        100,
      );
      assert.ok(res.ok);
      assert.equal(res.value.length, 2);
      const g = await rag.getById?.('tool:ReadFunctionGroup');
      assert.equal(g?.ok && g.value?.text, A);
    });

    it('records written without an id still dedup by similarity', async () => {
      const rag = make();
      await rag.upsert(A, {});
      await rag.upsert(B, {});
      const e = conformanceEmbedder();
      const res = await rag.query(
        { text: A, toVector: async () => (await e.embed(A)).vector },
        100,
      );
      assert.ok(res.ok);
      assert.equal(res.value.length, 1);
      assert.equal(res.value[0].text, B);
    });
  });
}
