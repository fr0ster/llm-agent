import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  INVALID_ARGUMENT,
  RagError,
  symmetricEmbedder,
} from '@mcp-abap-adt/llm-agent';
import {
  CONFORMANCE_EMBEDDING_DIM,
  conformanceEmbedder,
  isScanDeleteCaseSkipped,
  type ScanDeleteStore,
  scanDeleteConformanceCases,
} from '@mcp-abap-adt/llm-agent/testing/scan-delete-conformance';
import { QdrantRag } from '../qdrant-rag.js';
import { QdrantRagProvider } from '../qdrant-rag-provider.js';
import { scrollFilter } from '../scan-delete.js';
import { type QdrantStub, startQdrantStub } from './qdrant-stub.js';

const embedder = symmetricEmbedder(conformanceEmbedder());

let stub: QdrantStub;
before(async () => {
  stub = await startQdrantStub();
});
after(async () => {
  await stub.close();
});

/**
 * Creates a collection the way test/integration/qdrant-scan/run.mjs does on a
 * live Qdrant: `PUT /collections/{name}` with the vector size and the
 * distance `QdrantRag` creates its collections with. `QdrantRag.scan` never
 * creates one, so a kit subject must exist before its first scan.
 */
async function createCollection(baseUrl: string, name: string): Promise<void> {
  const res = await fetch(`${baseUrl}/collections/${name}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      vectors: { size: CONFORMANCE_EMBEDDING_DIM, distance: 'Cosine' },
    }),
  });
  if (!res.ok) throw new Error(`create ${name}: HTTP ${res.status}`);
}

let n = 0;
/** A store over a fresh, existing, empty collection of the shared stub. */
async function open(): Promise<QdrantRag> {
  const collectionName = `scan_${n++}`;
  await createCollection(stub.baseUrl, collectionName);
  return new QdrantRag({ url: stub.baseUrl, collectionName, embedder });
}

// The shared kit over QdrantRag and a storing stub of the REST API; a second
// QdrantRag on another collection of the same stub is the `sibling`; a
// QdrantRagProvider over the same stub is the `catalog`.
describe('QdrantRag — scan/delete conformance (stub)', () => {
  for (const c of scanDeleteConformanceCases) {
    it(c.name, async (t) => {
      try {
        await c.run(async () => ({
          store: async () => (await open()) as ScanDeleteStore,
          sibling: async () => (await open()) as ScanDeleteStore,
          catalog: async () => {
            const provider = new QdrantRagProvider({
              name: 'qdrant',
              url: stub.baseUrl,
              embedder,
            });
            return {
              provider,
              async create(name) {
                // The store the record names must exist, as the provider
                // would have created it; the record itself goes through
                // createCollection.
                const r = await provider.createCollection(name, {
                  scope: 'user',
                  userId: 'u1',
                  attributes: { seeded: true },
                });
                if (!r.ok) throw r.error;
              },
            };
          },
        }));
      } catch (err) {
        if (!isScanDeleteCaseSkipped(err)) throw err;
        t.skip(err.message);
      }
    });
  }
});

describe('QdrantRag — scan/delete requests', () => {
  it('scrollFilter matches the written payload keys by string value, no ttl', () => {
    assert.equal(scrollFilter(undefined), undefined);
    assert.equal(scrollFilter({}), undefined);
    assert.deepEqual(scrollFilter({ userId: 'u', namespace: 'n' }), {
      must: [
        { key: 'userId', match: { value: 'u' } },
        { key: 'namespace', match: { value: 'n' } },
      ],
    });
  });

  it('scan posts a payload-only scroll and ends on a null offset', async () => {
    const store = await open();
    const w = store.writer();
    await w.upsertRaw('a', 'text a', { userId: 'u1' });
    await w.upsertRaw('b', 'text b', { userId: 'u2' });
    stub.requests.length = 0;
    const r = await store.scan({ filter: { userId: 'u1' }, pageSize: 5 });
    assert.ok(r.ok);
    assert.deepEqual(
      r.value.records.map((x) => x.id),
      ['a'],
    );
    assert.equal(r.value.cursor, undefined);
    const req = stub.requests.find((x) => x.path.endsWith('/points/scroll'));
    assert.deepEqual(req?.body, {
      limit: 5,
      with_payload: true,
      filter: { must: [{ key: 'userId', match: { value: 'u1' } }] },
      with_vector: false,
    });
  });

  it('scan falls back to the point id when the payload has no id', async () => {
    const store = await open();
    const name = (store as unknown as { collectionName: string })
      .collectionName;
    stub.collections
      .get(name)
      ?.points.set('00000000-0000-0000-0000-000000000001', {
        id: '00000000-0000-0000-0000-000000000001',
        vector: [],
        payload: { text: 'raw' },
      });
    const r = await store.scan();
    assert.ok(r.ok);
    assert.equal(r.value.records[0].id, '00000000-0000-0000-0000-000000000001');
    assert.equal(r.value.records[0].text, 'raw');
  });

  it('scan rejects a bad pageSize before any request', async () => {
    const store = await open();
    stub.requests.length = 0;
    for (const pageSize of [0, -1, 1.5, Number.NaN]) {
      const r = await store.scan({ pageSize });
      assert.ok(!r.ok);
      assert.equal(r.error.code, INVALID_ARGUMENT);
    }
    assert.equal(stub.requests.length, 0);
  });

  it('scan rejects a cursor that is not a Qdrant point offset before any request', async () => {
    const store = await open();
    stub.requests.length = 0;
    for (const cursor of [
      '1.5',
      '-1',
      'abc',
      '"abc"',
      '"1"',
      '"not-a-uuid"',
      '9007199254740993',
      'null',
      '{}',
      '',
    ]) {
      const r = await store.scan({ cursor });
      assert.ok(!r.ok, `cursor ${cursor} is refused`);
      assert.equal(r.error.code, INVALID_ARGUMENT, cursor);
    }
    assert.equal(stub.requests.length, 0);
  });

  it('scan accepts an unsigned integer and a UUID cursor', async () => {
    const store = await open();
    stub.requests.length = 0;
    for (const cursor of [
      '0',
      '42',
      '"550e8400-e29b-41d4-a716-446655440000"',
    ]) {
      const r = await store.scan({ cursor });
      assert.ok(r.ok, `cursor ${cursor} is accepted`);
    }
    assert.equal(stub.requests.length, 3);
  });

  it('scan drops a point whose identity value is an array, whatever the page', async () => {
    const store = await open();
    const w = store.writer();
    await w.upsertRaw('arr', 'text', { userId: ['u1', 'u2'] });
    await w.upsertRaw('one', 'text', { userId: 'u1' });
    const r = await store.scan({ filter: { userId: 'u1' } });
    assert.ok(r.ok);
    assert.deepEqual(
      r.value.records.map((x) => x.id),
      ['one'],
    );
  });

  it('deleteWhere counts only the ids still present at delete time', async () => {
    const store = await open();
    const name = (store as unknown as { collectionName: string })
      .collectionName;
    const points = stub.collections.get(name)?.points;
    assert.ok(points);
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const id = `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`;
      ids.push(id);
      points.set(id, { id, vector: [], payload: { text: 't', userId: 'c' } });
    }
    // Another caller deletes one point after the snapshot, before the batch.
    stub.beforePointsRetrieve = () => {
      points.delete(ids[3]);
      stub.beforePointsRetrieve = undefined;
    };
    const r = await store.deleteWhere({ userId: 'c' });
    stub.beforePointsRetrieve = undefined;
    assert.ok(r.ok);
    assert.equal(r.value.deleted, 9);
    assert.equal(points.size, 0);
    const del = stub.requests.filter((x) => x.path.endsWith('/points/delete'));
    const last = del[del.length - 1];
    assert.equal((last.body as { points: string[] }).points.length, 9);
  });

  it('deleteWhere never deletes a point whose identity value is an array', async () => {
    const store = await open();
    const w = store.writer();
    await w.upsertRaw('arr', 'text', { userId: ['u1', 'u2'] });
    await w.upsertRaw('one', 'text', { userId: 'u1' });
    const r = await store.deleteWhere({ userId: 'u1' });
    assert.ok(r.ok);
    assert.equal(r.value.deleted, 1);
    const left = await store.scan();
    assert.ok(left.ok);
    assert.deepEqual(
      left.value.records.map((x) => x.id),
      ['arr'],
    );
  });

  it('scan and deleteWhere return ABORTED for an aborted signal', async () => {
    const store = await open();
    const ctrl = new AbortController();
    ctrl.abort();
    stub.requests.length = 0;
    const s = await store.scan({}, { signal: ctrl.signal });
    assert.ok(!s.ok);
    assert.equal(s.error.code, 'ABORTED');
    const d = await store.deleteWhere({ userId: 'u' }, { signal: ctrl.signal });
    assert.ok(!d.ok);
    assert.equal(d.error.code, 'ABORTED');
    assert.equal(stub.requests.length, 0);
  });

  it('a missing collection is an error, not an empty result', async () => {
    const store = new QdrantRag({
      url: stub.baseUrl,
      collectionName: 'no_such_collection',
      embedder,
    });
    const s = await store.scan();
    assert.ok(!s.ok);
    assert.ok(s.error instanceof RagError);
    assert.equal(s.error.code, 'QUERY_ERROR');
    const d = await store.deleteWhere({ userId: 'u' });
    assert.ok(!d.ok);
    assert.equal(d.error.code, 'DELETE_ERROR');
  });

  it('deleteWhere deletes in batches of at most 1000 with wait=true', async () => {
    const store = await open();
    const name = (store as unknown as { collectionName: string })
      .collectionName;
    const points = stub.collections.get(name)?.points;
    assert.ok(points);
    for (let i = 0; i < 2300; i++) {
      const id = `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`;
      points.set(id, {
        id,
        vector: [],
        payload: { text: 't', userId: i < 2200 ? 'bulk' : 'keep' },
      });
    }
    stub.requests.length = 0;
    const r = await store.deleteWhere({ userId: 'bulk' });
    assert.ok(r.ok);
    assert.equal(r.value.deleted, 2200);
    assert.equal(points.size, 100);
    const deletes = stub.requests.filter((x) =>
      x.path.endsWith('/points/delete'),
    );
    assert.deepEqual(
      deletes.map((x) => (x.body as { points: string[] }).points.length),
      [1000, 1000, 200],
    );
  });

  it('deleteWhere aborted between batches reports how many were deleted', async () => {
    const store = await open();
    const name = (store as unknown as { collectionName: string })
      .collectionName;
    const points = stub.collections.get(name)?.points;
    assert.ok(points);
    for (let i = 0; i < 1500; i++) {
      const id = `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`;
      points.set(id, { id, vector: [], payload: { text: 't', userId: 'x' } });
    }
    const ctrl = new AbortController();
    let deletes = 0;
    stub.failOn = (req) => {
      // abort while the second batch is in flight: the first is done
      if (req.path.endsWith('/points/delete') && ++deletes === 2) {
        setImmediate(() => ctrl.abort());
      }
      return false;
    };
    const r = await store.deleteWhere({ userId: 'x' }, { signal: ctrl.signal });
    stub.failOn = undefined;
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'ABORTED');
    assert.match(r.error.message, /deleting 1000 record\(s\)/);
  });
});
