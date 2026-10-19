import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  INVALID_ARGUMENT,
  RAG_COLLECTION_NOT_FOUND,
  symmetricEmbedder,
} from '@mcp-abap-adt/llm-agent';
import { conformanceEmbedder } from '@mcp-abap-adt/llm-agent/testing/scan-delete-conformance';
import { deterministicUUID } from '../qdrant-rag.js';
import { QdrantRagProvider } from '../qdrant-rag-provider.js';
import { type QdrantStub, startQdrantStub } from './qdrant-stub.js';

const CATALOG = 'rag_collection_catalog';
const embedder = symmetricEmbedder(conformanceEmbedder());

let stub: QdrantStub;
before(async () => {
  stub = await startQdrantStub();
});
after(async () => {
  await stub.close();
});

const provider = () =>
  new QdrantRagProvider({ name: 'qdrant', url: stub.baseUrl, embedder });
const payloadOf = async (store: string) =>
  stub.collections.get(CATALOG)?.points.get(await deterministicUUID(store))
    ?.payload;

const cyclic: Record<string, unknown> = {};
cyclic.self = cyclic;
const INVALID_ATTRIBUTES = [
  { x: Number.NaN },
  { x: undefined },
  { x: new Date() },
  { x: 10n },
  cyclic,
];

describe('QdrantRagProvider.updateCollection', () => {
  it('an empty patch is INVALID_ARGUMENT before any request', async () => {
    const before = stub.requests.length;
    for (const patch of [
      {},
      { collectionName: undefined, attributes: undefined },
    ]) {
      const r = await provider().updateCollection('a', patch);
      assert.ok(!r.ok);
      assert.equal(r.error.code, INVALID_ARGUMENT);
    }
    assert.equal(stub.requests.length, before);
  });

  it('attributes that have no JSON form are RAG_INVALID_ATTRIBUTES with no request', async () => {
    const mark = stub.requests.length;
    for (const attributes of INVALID_ATTRIBUTES) {
      const r = await provider().updateCollection('a', {
        attributes: attributes as Record<string, unknown>,
      });
      assert.ok(!r.ok);
      assert.equal(r.error.code, 'RAG_INVALID_ATTRIBUTES');
    }
    assert.equal(stub.requests.length, mark);
  });

  it('sets only the given keys on the catalog point, with wait=true semantics', async () => {
    const p = provider();
    const made = await p.createCollection('upd_a', {
      scope: 'user',
      userId: 'u1',
      attributes: { a: 1 },
    });
    assert.ok(made.ok);
    const before = await payloadOf('upd_a');
    const mark = stub.requests.length;
    const r = await p.updateCollection('upd_a', { attributes: { b: 2 } });
    assert.ok(r.ok);
    const after = await payloadOf('upd_a');
    assert.equal(after?.attributes_json, JSON.stringify({ b: 2 }));
    assert.equal(after?.collection_name, before?.collection_name);
    assert.equal(after?.scope, 'user');
    assert.equal(after?.user_id, 'u1');
    assert.equal(after?.store_name, 'upd_a');
    const sent = stub.requests
      .slice(mark)
      .find((q) => q.path.endsWith('/points/payload'));
    assert.ok(sent);
    assert.deepEqual(Object.keys((sent.body as { payload: object }).payload), [
      'attributes_json',
    ]);
  });

  it('an absent record is RAG_COLLECTION_NOT_FOUND, no write is sent and no point is created', async () => {
    const p = provider();
    const made = await p.createCollection('upd_present', { scope: 'global' });
    assert.ok(made.ok);
    const mark = stub.requests.length;
    const points = stub.collections.get(CATALOG)?.points.size;
    const r = await p.updateCollection('upd_absent', { collectionName: 'x' });
    assert.ok(!r.ok);
    assert.equal(r.error.code, RAG_COLLECTION_NOT_FOUND);
    assert.ok(
      stub.requests.slice(mark).every((q) => !q.path.endsWith('/payload')),
    );
    assert.equal(stub.collections.get(CATALOG)?.points.size, points);
  });

  it('a catalog collection that does not exist is RAG_COLLECTION_NOT_FOUND and is not created', async () => {
    const fresh = await startQdrantStub();
    try {
      const r = await new QdrantRagProvider({
        name: 'qdrant',
        url: fresh.baseUrl,
        embedder,
      }).updateCollection('a', { collectionName: 'x' });
      assert.ok(!r.ok);
      assert.equal(r.error.code, RAG_COLLECTION_NOT_FOUND);
      assert.equal(fresh.collections.size, 0);
    } finally {
      await fresh.close();
    }
  });

  it('a record deleted between the read and the write is RAG_COLLECTION_NOT_FOUND, nothing is created', async () => {
    const p = provider();
    const made = await p.createCollection('upd_race', { scope: 'global' });
    assert.ok(made.ok);
    const id = await deterministicUUID('upd_race');
    stub.beforePayloadWrite = () => {
      stub.collections.get(CATALOG)?.points.delete(id);
    };
    try {
      const mark = stub.requests.length;
      const r = await p.updateCollection('upd_race', { collectionName: 'x' });
      // The write was sent and the engine answered 404 (no such point).
      assert.ok(
        stub.requests
          .slice(mark)
          .some((q) => q.path.endsWith('/points/payload')),
      );
      assert.ok(!r.ok);
      assert.equal(r.error.code, RAG_COLLECTION_NOT_FOUND);
      assert.equal(stub.collections.get(CATALOG)?.points.has(id), false);
    } finally {
      stub.beforePayloadWrite = undefined;
    }
  });

  it('a refused set-payload is RAG_UPDATE_ERROR', async () => {
    const p = provider();
    const made = await p.createCollection('upd_fail', { scope: 'global' });
    assert.ok(made.ok);
    stub.failOn = (r) => r.path.endsWith('/points/payload');
    try {
      const r = await p.updateCollection('upd_fail', { collectionName: 'x' });
      assert.ok(!r.ok);
      assert.equal(r.error.code, 'RAG_UPDATE_ERROR');
    } finally {
      stub.failOn = undefined;
    }
  });
});
