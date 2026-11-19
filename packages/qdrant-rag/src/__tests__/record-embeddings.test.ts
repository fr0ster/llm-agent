import assert from 'node:assert/strict';
import { test } from 'node:test';
import { symmetricEmbedder } from '@mcp-abap-adt/llm-agent';
import { migrateQdrantMultivectors } from '../migrate-multivector.js';
import { deterministicUUID, QdrantRag } from '../qdrant-rag.js';
import { startQdrantStub } from './qdrant-stub.js';

const embedder = symmetricEmbedder({
  async embed(text) {
    return { vector: text.includes('finish') ? [0, 1] : [1, 0] };
  },
});
const lookup = { text: 'finish', toVector: async () => [0, 1] };
const full = 'early\n\nmiddle\n\nfinish';

test('one multivector point ranks by its last fragment and is replaced or removed whole', async (t) => {
  const stub = await startQdrantStub();
  t.after(() => stub.close());
  const rag = new QdrantRag({
    url: stub.baseUrl,
    collectionName: 'docs',
    embedder,
    fragmentSizeChars: 8,
  });
  const id = await deterministicUUID('long');
  assert.ok((await rag.upsert('short', { id: 'short' })).ok);
  assert.ok((await rag.upsert(full, { id: 'long', namespace: 'keep' })).ok);
  const collection = stub.collections.get('docs');
  assert.ok(collection?.multivector);
  assert.equal(collection.points.size, 2);
  assert.deepEqual(collection.points.get(id)?.vector, [
    [1, 0],
    [1, 0],
    [0, 1],
  ]);

  const hits = await rag.query(lookup, 2);
  const list = await rag.list({ includeText: true });
  const scan = await rag.scan();
  const record = await rag.getById('long');
  assert.ok(hits.ok && list.ok && scan.ok && record.ok);
  assert.deepEqual(
    hits.value.map(({ text }) => text),
    [full, 'short'],
  );
  assert.equal(hits.value[0].score, 1);
  assert.equal(record.value?.text, full);
  for (const page of [list.value, scan.value])
    assert.deepEqual(
      page.records.filter(({ id }) => id === 'long').map(({ text }) => text),
      [full],
    );

  assert.ok(
    (await rag.upsert('replace', { id: 'long', namespace: 'keep' })).ok,
  );
  assert.deepEqual(collection.points.get(id)?.vector, [[1, 0]]);
  const removed = await rag.deleteWhere({ namespace: 'keep' });
  assert.ok(removed.ok);
  assert.equal(removed.value.deleted, 1);
  assert.equal(collection.points.size, 1);
  assert.ok((await rag.upsert(full, { id: 'long' })).ok);
  assert.ok((await rag.writer().deleteByIdRaw('long')).ok);
  assert.equal(collection.points.size, 1);
});

test('legacy collections remain searchable and refuse a long record until migrated', async (t) => {
  const stub = await startQdrantStub();
  t.after(() => stub.close());
  stub.collections.set('docs', {
    size: 2,
    points: new Map(),
    payloadSchema: { namespace: { data_type: 'keyword' } },
  });
  const rag = new QdrantRag({
    url: stub.baseUrl,
    collectionName: 'docs',
    embedder,
    fragmentSizeChars: 8,
  });
  assert.ok((await rag.upsert('short', { id: 'legacy', namespace: 'old' })).ok);
  const before = await rag.query(lookup, 1);
  assert.ok(before.ok);
  assert.equal(before.value[0].text, 'short');
  const long = await rag.upsert(full, { id: 'legacy' });
  assert.ok(!long.ok);
  assert.match(
    long.error.message,
    /qdrant-migrate-multivector --collection "docs"/,
  );
  const opts = { url: stub.baseUrl, collection: 'docs' };
  stub.aliases.set('read_docs', 'docs');
  await assert.rejects(
    migrateQdrantMultivectors({ ...opts, collection: 'read_docs' }),
    /physical collection name/,
  );
  const writes = stub.requests.filter(
    ({ method }) => method === 'PUT' || method === 'DELETE',
  ).length;
  assert.equal(
    (await migrateQdrantMultivectors({ ...opts, dryRun: true }))[0].action,
    'migrate',
  );
  assert.equal(
    stub.requests.filter(
      ({ method }) => method === 'PUT' || method === 'DELETE',
    ).length,
    writes,
  );
  assert.equal((await migrateQdrantMultivectors(opts))[0].action, 'migrate');
  assert.equal(
    (await migrateQdrantMultivectors(opts))[0].action,
    'already-migrated',
  );
  const id = await deterministicUUID('legacy');
  assert.deepEqual(stub.collections.get('docs')?.points.get(id)?.vector, [
    [1, 0],
  ]);
  assert.deepEqual(stub.collections.get('docs')?.payloadSchema, {
    namespace: { data_type: 'keyword' },
  });
  assert.equal(stub.aliases.get('read_docs'), 'docs');
  assert.deepEqual(await rag.query(lookup, 1), before);
  assert.ok((await rag.upsert(full, { id: 'legacy' })).ok);
});

for (const [label, method, path] of [
  [
    'creating the backup',
    'PUT',
    /^\/collections\/__rag_multivector_migration__\w+$/,
  ],
  [
    'copying to the backup',
    'PUT',
    /^\/collections\/__rag_multivector_migration__\w+\/points$/,
  ],
  [
    'verifying the backup',
    'POST',
    /^\/collections\/__rag_multivector_migration__\w+\/points\/count$/,
  ],
  ['deleting the original', 'DELETE', /^\/collections\/docs$/],
  ['recreating the original', 'PUT', /^\/collections\/docs$/],
  ['copying back', 'PUT', /^\/collections\/docs\/points$/],
  ['verifying the original', 'POST', /^\/collections\/docs\/points\/count$/],
  [
    'removing the backup',
    'DELETE',
    /^\/collections\/__rag_multivector_migration__\w+$/,
  ],
] as const) {
  test(`migration resumes after interruption while ${label}`, async (t) => {
    const stub = await startQdrantStub();
    t.after(() => stub.close());
    const id = await deterministicUUID('legacy');
    const payload = { id: 'legacy', text: 'saved text', scope: ['reader'] };
    const point = { id, payload, vector: [1, 0] };
    stub.collections.set('docs', { size: 2, points: new Map([[id, point]]) });
    const opts = { url: stub.baseUrl, collection: 'docs' };
    stub.aliases.set('read_docs', 'docs');
    stub.failOn = (request) =>
      request.method === method &&
      path.test(request.path) &&
      (label !== 'verifying the original' ||
        stub.collections.get('docs')?.multivector === true);
    await assert.rejects(migrateQdrantMultivectors(opts), /HTTP 500/);
    stub.failOn = undefined;
    await migrateQdrantMultivectors(opts);
    assert.deepEqual([...stub.collections.keys()], ['docs']);
    assert.equal(stub.aliases.get('read_docs'), 'docs');
    assert.deepEqual(stub.collections.get('docs')?.points.get(id), {
      ...point,
      vector: [[1, 0]],
    });
  });
}

test('catalog migration preserves named dense and sparse fields and retries 429 without an attempt cap', async (t) => {
  const stub = await startQdrantStub();
  t.after(() => stub.close());
  const catalogId = await deterministicUUID('registered');
  const id = await deterministicUUID('doc');
  stub.collections.set('rag_collection_catalog', {
    size: 1,
    points: new Map([
      [
        catalogId,
        { id: catalogId, vector: [0], payload: { store_name: 'registered' } },
      ],
    ]),
  });
  const original = {
    id,
    vector: { dense: [0, 1], bm25: { indices: [8, 15], values: [0.2, 0.7] } },
    payload: { text: 'legacy', tags: ['keep'] },
  };
  const sparseVectors = { bm25: { modifier: 'idf', index: { on_disk: true } } };
  stub.collections.set('registered', {
    size: 2,
    vectorConfig: { dense: { size: 2, distance: 'Cosine' } },
    sparseVectors,
    points: new Map([[id, original]]),
  });
  stub.collections.set('unmanaged', { size: 2, points: new Map() });
  let attempts = 0;
  stub.throttle = (request) =>
    request.method === 'POST' &&
    request.path.endsWith('/registered/points/scroll') &&
    ++attempts <= 12;
  const report = await migrateQdrantMultivectors({ url: stub.baseUrl });
  assert.deepEqual(
    report.map(({ collection, action }) => [collection, action]),
    [['registered', 'migrate']],
  );
  assert.equal(attempts, 13);
  const collection = stub.collections.get('registered');
  assert.deepEqual(collection?.sparseVectors, sparseVectors);
  assert.deepEqual(collection?.points.get(id), {
    ...original,
    vector: { ...original.vector, dense: [[0, 1]] },
  });
  assert.ok(!stub.collections.get('unmanaged')?.multivector);
});

test('custom shard keys retain their points even when IDs are shared between keys', async (t) => {
  const stub = await startQdrantStub();
  t.after(() => stub.close());
  const id = await deterministicUUID('same');
  const point = { id, vector: [1, 0], payload: { text: 'west' } };
  stub.collections.set('geo', {
    size: 2,
    points: new Map(),
    shards: new Map([
      ['west', new Map([[id, point]])],
      ['east', new Map([[id, { ...point, payload: { text: 'east' } }]])],
    ]),
  });
  await migrateQdrantMultivectors({ url: stub.baseUrl, collection: 'geo' });
  const shards = stub.collections.get('geo')?.shards;
  assert.deepEqual(shards?.get('west')?.get(id), {
    ...point,
    vector: [[1, 0]],
  });
  assert.deepEqual(shards?.get('east')?.get(id), {
    ...point,
    payload: { text: 'east' },
    vector: [[1, 0]],
  });
});
