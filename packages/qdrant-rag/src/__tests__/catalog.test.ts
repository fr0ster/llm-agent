import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  IEmbedder,
  RagCollectionRecord,
  RagProviderCreateCollectionOptions,
} from '@mcp-abap-adt/llm-agent';
import { CatalogRecordDeleteError } from '@mcp-abap-adt/llm-agent';
import { deterministicUUID, QdrantRag } from '../qdrant-rag.js';
import { QdrantRagProvider } from '../qdrant-rag-provider.js';
import {
  type QdrantStub,
  type StubRequest,
  startQdrantStub,
} from './qdrant-stub.js';

const CATALOG = 'rag_collection_catalog';
const STORE = 'my_notes_a1b2c3d4e5f6';
const createOpts: RagProviderCreateCollectionOptions = {
  scope: 'user',
  userId: 'u-1',
  collectionName: 'my notes',
  attributes: { role: 'analyst' },
};

class CountingEmbedder implements IEmbedder {
  calls = 0;
  constructor(private readonly dim = 3) {}
  async embed() {
    this.calls++;
    return { vector: Array.from({ length: this.dim }, () => 0.5) };
  }
}
function providerOn(
  stub: QdrantStub,
  embedder: IEmbedder = new CountingEmbedder(),
): QdrantRagProvider {
  return new QdrantRagProvider({ name: 'q', url: stub.baseUrl, embedder });
}
async function withStub(
  run: (stub: QdrantStub) => Promise<void>,
): Promise<void> {
  const stub = await startQdrantStub();
  try {
    await run(stub);
  } finally {
    await stub.close();
  }
}
const is = (method: string, path: string) => (r: StubRequest) =>
  r.method === method && r.path === path;
const indexOf = (stub: QdrantStub, method: string, path: string): number =>
  stub.requests.findIndex(is(method, path));
async function seedRecord(
  stub: QdrantStub,
  storeName: string,
  payload: Record<string, unknown>,
): Promise<void> {
  if (!stub.collections.has(CATALOG))
    stub.collections.set(CATALOG, { size: 1, points: new Map() });
  const id = await deterministicUUID(storeName);
  stub.collections.get(CATALOG)?.points.set(id, { id, vector: [1], payload });
}

describe('qdrant catalog: createCollection', () => {
  it('creates the collection with the probe size, then records it last, spending one embedding', () =>
    withStub(async (stub) => {
      const embedder = new CountingEmbedder(3);
      const res = await providerOn(stub, embedder).createCollection(
        STORE,
        createOpts,
      );
      assert.ok(res.ok);
      assert.ok(res.value.rag instanceof QdrantRag);
      assert.equal(
        embedder.calls,
        1,
        'one probe embedding per collection created',
      );
      assert.equal(stub.collections.get(STORE)?.size, 3);
      const createdAt = indexOf(stub, 'PUT', `/collections/${STORE}`);
      const recordAt = indexOf(stub, 'PUT', `/collections/${CATALOG}/points`);
      assert.ok(
        createdAt >= 0 && recordAt > createdAt,
        'store first, record last',
      );
      const described = await providerOn(stub).describeCollections();
      assert.ok(described.ok);
      assert.deepEqual(described.value, {
        records: [
          {
            scope: 'user',
            userId: 'u-1',
            storeName: STORE,
            name: 'my notes',
            attributes: { role: 'analyst' },
          },
        ],
        rejected: [],
      });
    }));

  it('refuses a collection whose record exists, and creates nothing', () =>
    withStub(async (stub) => {
      await seedRecord(stub, STORE, {
        store_name: STORE,
        collection_name: 'x',
        scope: 'global',
        attributes_json: null,
        write_id: 'w',
      });
      const res = await providerOn(stub).createCollection(STORE, createOpts);
      assert.equal(!res.ok && res.error.code, 'RAG_DUPLICATE_COLLECTION');
      assert.equal(indexOf(stub, 'PUT', `/collections/${STORE}`), -1);
    }));

  it('refuses a collection that exists without a record, naming it, and adopts it on request', () =>
    withStub(async (stub) => {
      stub.collections.set(STORE, { size: 3, points: new Map() });
      const refused = await providerOn(stub).createCollection(
        STORE,
        createOpts,
      );
      assert.equal(!refused.ok && refused.error.code, 'RAG_ORPHAN_STORE');
      assert.match(!refused.ok ? refused.error.message : '', new RegExp(STORE));
      const embedder = new CountingEmbedder();
      const adopted = await providerOn(stub, embedder).createCollection(STORE, {
        ...createOpts,
        adoptExisting: true,
      });
      assert.equal(adopted.ok, true);
      assert.equal(
        embedder.calls,
        0,
        'adoption creates nothing, so it embeds nothing',
      );
      const records = await providerOn(stub).describeCollections();
      assert.ok(records.ok && records.value.records.length === 1);
    }));

  it('refuses adoptExisting for a collection that is not there, and creates nothing', () =>
    withStub(async (stub) => {
      const res = await providerOn(stub).createCollection(STORE, {
        ...createOpts,
        adoptExisting: true,
      });
      assert.equal(!res.ok && res.error.code, 'RAG_CREATE_ERROR');
      assert.ok(!stub.collections.has(STORE));
    }));

  it('leaves the collection in place, named, when the record cannot be written', () =>
    withStub(async (stub) => {
      stub.failOn = is('PUT', `/collections/${CATALOG}/points`);
      const res = await providerOn(stub).createCollection(STORE, createOpts);
      assert.equal(!res.ok && res.error.code, 'RAG_ORPHAN_STORE');
      assert.ok(stub.collections.has(STORE));
      assert.equal(indexOf(stub, 'DELETE', `/collections/${STORE}`), -1);
    }));

  it('loses cleanly when another registry recorded the same collection first', () =>
    withStub(async (stub) => {
      // computed before the race: the hook is synchronous and must land the
      // winner's point before the stub applies this call's insert_only write
      const winnerId = await deterministicUUID(STORE);
      stub.beforeCatalogWrite = () => {
        stub.beforeCatalogWrite = undefined;
        stub.collections.get(CATALOG)?.points.set(winnerId, {
          id: winnerId,
          vector: [1],
          payload: {
            store_name: STORE,
            collection_name: 'my notes',
            scope: 'user',
            user_id: 'u-1',
            attributes_json: null,
            write_id: 'the-winner',
          },
        });
      };
      const res = await providerOn(stub).createCollection(STORE, createOpts);
      assert.equal(!res.ok && res.error.code, 'RAG_DUPLICATE_COLLECTION');
      assert.ok(
        stub.collections.has(STORE),
        "the winner's record points at it",
      );
    }));

  it('refuses an owner without its key before any request', () =>
    withStub(async (stub) => {
      const res = await providerOn(stub).createCollection(STORE, {
        scope: 'user',
      } as unknown as RagProviderCreateCollectionOptions);
      assert.equal(!res.ok && res.error.code, 'RAG_INVALID_OWNER');
      assert.deepEqual(stub.requests, []);
    }));
});

describe('qdrant catalog: no handle creates its collection', () => {
  it('openCollection issues no request, and a write to a missing collection fails instead of creating it', () =>
    withStub(async (stub) => {
      const record: RagCollectionRecord = {
        storeName: STORE,
        name: 'n',
        scope: 'global',
      };
      const opened = await providerOn(stub).openCollection(record);
      assert.ok(opened.ok);
      assert.deepEqual(stub.requests, []);
      assert.equal(
        (await opened.value.editor.upsert('hello', { id: 'r1' })).ok,
        false,
      );
      assert.ok(!stub.collections.has(STORE));
      assert.equal(indexOf(stub, 'PUT', `/collections/${STORE}`), -1);
    }));

  it('openCollection answers a failed Result, never a rejection, when building a handle throws', async () => {
    const provider = new QdrantRagProvider({
      name: 'q',
      url: 'http://127.0.0.1:9', // never contacted: no request is made
      embedder: new CountingEmbedder(),
      idStrategyFactory: () => {
        throw new Error('id strategy refused');
      },
    });
    const opened = await provider.openCollection({
      storeName: STORE,
      name: 'n',
      scope: 'global',
    });
    assert.equal(opened.ok, false);
    assert.ok(!opened.ok && opened.error.code === 'RAG_OPEN_ERROR');
    assert.match(!opened.ok ? opened.error.message : '', /id strategy refused/);
  });

  it('a handle whose collection was deleted elsewhere fails rather than recreating it', () =>
    withStub(async (stub) => {
      const created = await providerOn(stub).createCollection(
        STORE,
        createOpts,
      );
      assert.ok(created.ok);
      stub.collections.delete(STORE);
      assert.equal(
        (await created.value.editor.upsert('hello', { id: 'r1' })).ok,
        false,
      );
      assert.ok(!stub.collections.has(STORE));
    }));
});

describe('qdrant catalog: describeCollections', () => {
  it('returns nothing, and creates nothing, when no catalog exists yet', () =>
    withStub(async (stub) => {
      assert.deepEqual(await providerOn(stub).describeCollections(), {
        ok: true,
        value: { records: [], rejected: [] },
      });
      assert.equal(indexOf(stub, 'PUT', `/collections/${CATALOG}`), -1);
    }));

  it('pages through the catalog and rejects malformed points', () =>
    withStub(async (stub) => {
      for (let i = 0; i < 257; i++) {
        await seedRecord(stub, `s_${i}`, {
          store_name: `s_${i}`,
          collection_name: `c${i}`,
          scope: 'global',
          attributes_json: null,
          write_id: 'w',
        });
      }
      await seedRecord(stub, 'bad_1', {
        store_name: 'bad_1',
        collection_name: 'c',
        scope: 'session',
        attributes_json: null,
        write_id: 'w',
      });
      const res = await providerOn(stub).describeCollections();
      assert.ok(res.ok);
      assert.equal(res.value.records.length, 257);
      assert.deepEqual(
        res.value.rejected.map((r) => r.storeName),
        ['bad_1'],
      );
    }));
});

describe('qdrant catalog: deleteCollection', () => {
  it('deletes the record before the collection', () =>
    withStub(async (stub) => {
      assert.ok(
        (await providerOn(stub).createCollection(STORE, createOpts)).ok,
      );
      assert.equal((await providerOn(stub).deleteCollection(STORE)).ok, true);
      const recordAt = indexOf(
        stub,
        'POST',
        `/collections/${CATALOG}/points/delete`,
      );
      const dataAt = indexOf(stub, 'DELETE', `/collections/${STORE}`);
      assert.ok(recordAt >= 0 && dataAt > recordAt);
      const records = await providerOn(stub).describeCollections();
      assert.ok(records.ok && records.value.records.length === 0);
    }));

  it('stops with CatalogRecordDeleteError, touching nothing, when the record cannot be deleted', () =>
    withStub(async (stub) => {
      assert.ok(
        (await providerOn(stub).createCollection(STORE, createOpts)).ok,
      );
      stub.failOn = is('POST', `/collections/${CATALOG}/points/delete`);
      const res = await providerOn(stub).deleteCollection(STORE);
      assert.ok(!res.ok && res.error instanceof CatalogRecordDeleteError);
      assert.equal(indexOf(stub, 'DELETE', `/collections/${STORE}`), -1);
      assert.ok(stub.collections.has(STORE));
    }));

  it('reports a collection failure after the record is gone as a plain delete error', () =>
    withStub(async (stub) => {
      assert.ok(
        (await providerOn(stub).createCollection(STORE, createOpts)).ok,
      );
      stub.failOn = is('DELETE', `/collections/${STORE}`);
      const res = await providerOn(stub).deleteCollection(STORE);
      assert.equal(!res.ok && res.error.code, 'RAG_DELETE_ERROR');
    }));
});
