import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IRag } from '../../interfaces/rag.js';
import {
  INVALID_ARGUMENT,
  type IRagFilteredDeleter,
  type IRagScanner,
} from '../../interfaces/rag-scan.js';
import type { RagMetadata } from '../../interfaces/types.js';
import { conformanceEmbedder } from '../../testing/rag-filter-conformance.js';
import { InMemoryRag } from '../in-memory-rag.js';
import { symmetricEmbedder } from '../retrieval-embedder.js';
import { VectorRag } from '../vector-rag.js';

type Store = IRag & IRagScanner & IRagFilteredDeleter;

// A dedup threshold above 1 can never merge records written without an id.
const NO_DEDUP = 1.5;

const stores: Array<[string, (namespace?: string) => Store]> = [
  [
    'InMemoryRag',
    (namespace) => new InMemoryRag({ dedupThreshold: NO_DEDUP, namespace }),
  ],
  [
    'VectorRag',
    (namespace) =>
      new VectorRag(symmetricEmbedder(conformanceEmbedder()), {
        dedupThreshold: NO_DEDUP,
        namespace,
      }),
  ],
];

async function drain(
  store: IRagScanner,
  opts: Parameters<IRagScanner['scan']>[0],
): Promise<{ ids: string[]; pages: number }> {
  const ids: string[] = [];
  let pages = 0;
  let cursor: string | undefined;
  do {
    const res = await store.scan({ ...opts, cursor });
    assert.ok(res.ok);
    pages++;
    ids.push(...res.value.records.map((r) => r.id));
    cursor = res.value.cursor;
  } while (cursor !== undefined && pages < 100);
  return { ids, pages };
}

async function seed(
  store: Store,
  rows: Array<[string, RagMetadata]>,
): Promise<void> {
  const w = store.writer?.();
  assert.ok(w);
  for (const [id, meta] of rows) {
    const res = await w.upsertRaw(id, `text ${id}`, meta);
    assert.ok(res.ok);
  }
}

for (const [name, make] of stores) {
  describe(`${name} scan / deleteWhere`, () => {
    it('pages 5 records with pageSize 2 exactly once, stable order, last page has no cursor', async () => {
      const s = make();
      await seed(s, [
        ['a', {}],
        ['b', {}],
        ['c', {}],
        ['d', {}],
        ['e', {}],
      ]);
      const first = await s.scan({ pageSize: 2 });
      assert.ok(first.ok);
      assert.equal(first.value.records.length, 2);
      assert.ok(first.value.cursor);
      const { ids, pages } = await drain(s, { pageSize: 2 });
      assert.deepEqual(ids, ['a', 'b', 'c', 'd', 'e']);
      assert.equal(pages, 3);
      const again = await drain(s, { pageSize: 2 });
      assert.deepEqual(again.ids, ids);
      const last = await s.scan({ pageSize: 5 });
      assert.ok(last.ok);
      assert.equal(last.value.cursor, undefined);
    });

    it('applies the filter by strict equality', async () => {
      const s = make();
      await seed(s, [
        ['a', { userId: 'u1', sessionId: 's1' }],
        ['b', { userId: 'u1', sessionId: 's2' }],
        ['c', { userId: 'u2' }],
        ['d', {}],
      ]);
      assert.deepEqual((await drain(s, { filter: { userId: 'u1' } })).ids, [
        'a',
        'b',
      ]);
      assert.deepEqual(
        (await drain(s, { filter: { userId: 'u1', sessionId: 's2' } })).ids,
        ['b'],
      );
      assert.deepEqual((await drain(s, { filter: { userId: 'U1' } })).ids, []);
    });

    it('returns an id-less record with its insertion key and no vector', async () => {
      const s = make();
      assert.ok((await s.upsert('first idless', { userId: 'u' })).ok);
      assert.ok((await s.upsert('second idless', { userId: 'u' })).ok);
      const res = await s.scan();
      assert.ok(res.ok);
      assert.equal(res.value.records.length, 2);
      const [r0, r1] = res.value.records;
      assert.ok(r0.id.length > 0 && r1.id.length > 0 && r0.id !== r1.id);
      assert.equal(r0.text, 'first idless');
      assert.deepEqual(Object.keys(r0).sort(), ['id', 'metadata', 'text']);
    });

    it('includes expired records', async () => {
      const s = make();
      await seed(s, [
        ['old', { ttl: 1 }],
        ['new', {}],
      ]);
      assert.deepEqual((await drain(s, {})).ids, ['old', 'new']);
    });

    it('does not skip a raw-written record', async () => {
      const s = make();
      await seed(s, [['raw', { userId: 'u' }]]);
      assert.deepEqual((await drain(s, { filter: { userId: 'u' } })).ids, [
        'raw',
      ]);
    });

    it('deleteWhere returns the exact count and removes only matches', async () => {
      const s = make();
      await seed(s, [
        ['a', { userId: 'u1' }],
        ['b', { userId: 'u1' }],
        ['c', { userId: 'u2' }],
      ]);
      const res = await s.deleteWhere({ userId: 'u1' });
      assert.ok(res.ok);
      assert.equal(res.value.deleted, 2);
      assert.deepEqual((await drain(s, {})).ids, ['c']);
      const none = await s.deleteWhere({ userId: 'nobody' });
      assert.ok(none.ok);
      assert.equal(none.value.deleted, 0);
    });

    it('deleteWhere refuses an empty filter', async () => {
      const s = make();
      await seed(s, [['a', {}]]);
      const res = await s.deleteWhere({});
      assert.ok(!res.ok);
      assert.equal(res.error.code, INVALID_ARGUMENT);
      assert.deepEqual((await drain(s, {})).ids, ['a']);
    });

    it('a scan survives deletions between pages without skipping', async () => {
      const s = make();
      await seed(s, [
        ['a', { userId: 'x' }],
        ['b', {}],
        ['c', {}],
        ['d', {}],
      ]);
      const p1 = await s.scan({ pageSize: 2 });
      assert.ok(p1.ok);
      await s.deleteWhere({ userId: 'x' });
      const p2 = await s.scan({ pageSize: 2, cursor: p1.value.cursor });
      assert.ok(p2.ok);
      assert.deepEqual(
        p2.value.records.map((r) => r.id),
        ['c', 'd'],
      );
    });

    it('rejects a malformed cursor', async () => {
      const s = make();
      const res = await s.scan({ cursor: 'not-a-cursor' });
      assert.ok(!res.ok);
      assert.equal(res.error.code, INVALID_ARGUMENT);
    });
  });
}

describe('InMemoryRag configured namespace boundary (query: exact match)', () => {
  it('bounds scan and deleteWhere to the store namespace', async () => {
    const s = new InMemoryRag({ dedupThreshold: NO_DEDUP, namespace: 'ns' });
    const w = s.writer?.();
    assert.ok(w);
    await w.upsertRaw('in', 'text in', { userId: 'u' }); // gets store namespace
    await w.upsertRaw('other', 'text other', { namespace: 'zz', userId: 'u' });
    await w.upsertRaw('mine', 'text mine', { namespace: 'ns', userId: 'u' });
    assert.deepEqual((await drain(s, {})).ids, ['in', 'mine']);
    // A filter naming another namespace cannot widen the boundary.
    assert.deepEqual((await drain(s, { filter: { namespace: 'zz' } })).ids, []);
    const del = await s.deleteWhere({ userId: 'u' });
    assert.ok(del.ok);
    assert.equal(del.value.deleted, 2);
    // the foreign-namespace record survives
    assert.equal((s as unknown as { records: unknown[] }).records.length, 1);
  });

  it('a record without a namespace is outside the boundary', async () => {
    const s = new InMemoryRag({ namespace: 'ns' });
    (s as unknown as { records: Array<Record<string, unknown>> }).records.push({
      key: 0,
      id: 'x',
      text: 'bare',
      embedding: new Map(),
      metadata: { id: 'bare', userId: 'u' },
    });
    assert.deepEqual((await drain(s, {})).ids, []);
    const del = await s.deleteWhere({ userId: 'u' });
    assert.ok(del.ok);
    assert.equal(del.value.deleted, 0);
  });
});

describe('VectorRag configured namespace boundary (query: no-namespace records are inside)', () => {
  it('bounds scan and deleteWhere; records without a namespace are inside', async () => {
    const s = new VectorRag(symmetricEmbedder(conformanceEmbedder()), {
      dedupThreshold: NO_DEDUP,
      namespace: 'ns',
    });
    const w = s.writer?.();
    assert.ok(w);
    await w.upsertRaw('bare', 'text bare', { userId: 'u' });
    await w.upsertRaw('mine', 'text mine', { namespace: 'ns', userId: 'u' });
    // Written around the store's upsert guard to model a foreign record.
    (
      s as unknown as {
        records: Array<{
          text: string;
          vector: number[];
          metadata: RagMetadata;
        }>;
      }
    ).records.push({
      text: 'foreign',
      vector: [1],
      metadata: { id: 'foreign', namespace: 'zz', userId: 'u' },
    });
    assert.deepEqual((await drain(s, {})).ids, ['bare', 'mine']);
    assert.deepEqual((await drain(s, { filter: { namespace: 'zz' } })).ids, []);
    const del = await s.deleteWhere({ userId: 'u' });
    assert.ok(del.ok);
    assert.equal(del.value.deleted, 2);
    const left = (
      s as unknown as { records: Array<{ metadata: RagMetadata } | null> }
    ).records;
    assert.deepEqual(
      left.filter((r) => r !== null).map((r) => r?.metadata.id),
      ['foreign'],
    );
  });
});
