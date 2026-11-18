import assert from 'node:assert/strict';
import { test } from 'node:test';
import { symmetricEmbedder } from '@mcp-abap-adt/llm-agent';
import { deterministicUUID, QdrantRag } from '../qdrant-rag.js';
import { startQdrantStub } from './qdrant-stub.js';

test('keeps fragments in a single Qdrant point and ranks whole records', async (t) => {
  const stub = await startQdrantStub();
  t.after(() => stub.close());
  const embedder = symmetricEmbedder({
    async embed(text) {
      return { vector: text.includes('finish') ? [0, 1] : [1, 0] };
    },
  });
  const id = await deterministicUUID('long');
  const legacy = await deterministicUUID('legacy');
  const collection = {
    size: 2,
    points: new Map([
      [
        legacy,
        {
          id: legacy,
          payload: { id: 'legacy', text: 'legacy' },
          vector: [1, 1],
        },
      ],
    ]),
  };
  stub.collections.set('docs', collection);
  const config = {
    url: stub.baseUrl,
    collectionName: 'docs',
    embedder,
    fragmentSizeChars: 8,
  };
  const rag = new QdrantRag(config);
  const lookup = { text: 'finish', toVector: async () => [0, 1] };
  const full = 'early\n\nmiddle\n\nfinish';
  const initial = await rag.query(lookup, 1);
  assert.ok(initial.ok);
  assert.equal(initial.value[0]?.text, 'legacy');

  assert.ok((await rag.upsert(full, { id: 'long' })).ok);
  assert.deepEqual(stub.collections.get('docs')?.points.get(id), {
    id,
    vector: [1, 0],
    payload: {
      id: 'long',
      ownerScope: 'global',
      text: {
        value: full,
        fragmentVectors: [
          [1, 0],
          [0, 1],
        ],
      },
    },
  });
  assert.equal(collection.points.size, 2);

  const reader = new QdrantRag(config);
  const best = await reader.query(lookup, 1);
  const both = await reader.query(lookup, 2);
  const retrieved = await reader.getById('long');
  const scanned = await reader.scan();
  const listed = await reader.list({ includeText: true });
  assert.ok(best.ok && both.ok && retrieved.ok && scanned.ok && listed.ok);
  assert.deepEqual(
    best.value.map((r) => r.text),
    [full],
  );
  assert.equal(best.value[0]?.score, 1);
  assert.deepEqual(
    both.value.map((r) => r.text),
    [full, 'legacy'],
  );
  assert.equal(retrieved.value?.text, full);
  for (const page of [scanned.value, listed.value]) {
    assert.equal(page.records.length, 2);
    assert.equal(page.records.find((r) => r.id === 'long')?.text, full);
  }

  assert.ok((await rag.upsert('short', { id: 'long' })).ok);
  assert.equal(
    stub.collections.get('docs')?.points.get(id)?.payload.text,
    'short',
  );
  const replaced = await reader.query(lookup, 1);
  assert.ok(replaced.ok);
  assert.equal(replaced.value[0]?.text, 'legacy');

  assert.ok((await rag.upsert(full, { id: 'long' })).ok);
  assert.ok(
    (
      await rag
        .writer()
        .upsertManyPrecomputedRaw?.([
          { id: 'long', text: full, vector: [1, 0], metadata: {} },
        ])
    )?.ok,
  );
  assert.equal(
    stub.collections.get('docs')?.points.get(id)?.payload.text,
    full,
  );
  assert.ok((await rag.upsert(full, { id: 'long' })).ok);
  assert.ok((await rag.writer().deleteByIdRaw('long')).ok);
  assert.equal(collection.points.size, 1);
  const deleted = await reader.query(lookup, 2);
  assert.ok(deleted.ok);
  assert.deepEqual(
    deleted.value.map((r) => r.text),
    ['legacy'],
  );
});
