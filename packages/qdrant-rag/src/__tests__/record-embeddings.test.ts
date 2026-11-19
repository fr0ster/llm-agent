import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { symmetricEmbedder } from '@mcp-abap-adt/llm-agent';
import {
  migrateQdrantMultivectors,
  releaseQdrantMultivectorMigrationLock,
} from '../migrate-multivector.js';
import { MIGRATION_LOCK_COLLECTION, MIGRATION_PREFIX } from '../multivector.js';
import { deterministicUUID, QdrantRag } from '../qdrant-rag.js';
import { startQdrantStub } from './qdrant-stub.js';

async function releaseAfterSettledWrite(options: {
  url: string;
  collection: string;
}) {
  let token: string | null = null;
  await migrateQdrantMultivectors({
    ...options,
    dryRun: true,
    onLockStatus: (status) => {
      if (status.locked) token = status.ownerToken;
    },
  });
  assert.ok(token);
  await releaseQdrantMultivectorMigrationLock(options, token);
}

const embedder = symmetricEmbedder({
  async embed(text) {
    return { vector: text.includes('finish') ? [0, 1] : [1, 0] };
  },
});
const lookup = { text: 'finish', toVector: async () => [0, 1] };
const full = 'early\n\nmiddle\n\nfinish';

function temporaryCollectionName(collection: string): string {
  return (
    MIGRATION_PREFIX + createHash('sha256').update(collection).digest('hex')
  );
}

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
    /^\/collections\/__rag_multivector_migration__[a-f0-9]{64}$/,
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
    /^\/collections\/__rag_multivector_migration__[a-f0-9]{64}$/,
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
    if (method !== 'POST') await releaseAfterSettledWrite(opts);
    await migrateQdrantMultivectors(opts);
    assert.deepEqual([...stub.collections.keys()], ['docs']);
    assert.equal(stub.aliases.get('read_docs'), 'docs');
    assert.deepEqual(stub.collections.get('docs')?.points.get(id), {
      ...point,
      vector: [[1, 0]],
    });
  });
}

test('migration can discover a backup before the first point is copied', async (t) => {
  const stub = await startQdrantStub();
  t.after(() => stub.close());
  const collection = 'docs';
  const temporaryCollection = temporaryCollectionName(collection);
  const id = await deterministicUUID('legacy');
  const point = { id, vector: [1, 0], payload: { text: 'saved text' } };
  stub.collections.set(collection, { size: 2, points: new Map([[id, point]]) });
  stub.failOn = ({ path }) => path === '/collections/docs/points/scroll';
  const opts = { url: stub.baseUrl };
  await assert.rejects(
    migrateQdrantMultivectors({ ...opts, collection }),
    /HTTP 500/,
  );
  stub.failOn = undefined;
  assert.equal(stub.collections.get(temporaryCollection)?.points.size, 0);
  assert.equal(stub.collections.get(collection)?.points.get(id), point);
  assert.deepEqual(await migrateQdrantMultivectors(opts), [
    { collection, temporaryCollection, action: 'resume' },
  ]);
  assert.deepEqual(stub.collections.get(collection)?.points.get(id), {
    ...point,
    vector: [[1, 0]],
  });
});

for (const [label, useCatalog, collection] of [
  ['--all without a catalog entry', true, undefined],
  ['--all without a catalog', false, undefined],
  ['a different --collection', false, 'next'],
] as const) {
  test(`migration restores an unregistered collection after DELETE with ${label}`, async (t) => {
    const stub = await startQdrantStub();
    t.after(() => stub.close());
    const original = `docs_${'long_name_'.repeat(24)}`;
    const id = await deterministicUUID('legacy');
    const point = { id, vector: [1, 0], payload: { text: 'saved text' } };
    const payloadSchema = { text: { data_type: 'keyword' } };
    stub.collections.set(original, {
      size: 2,
      points: new Map([[id, point]]),
      payloadSchema,
    });
    stub.aliases.set('read_docs', original);
    stub.collections.set('next', { size: 2, points: new Map() });
    if (useCatalog) {
      stub.collections.set('rag_collection_catalog', {
        size: 1,
        points: new Map([
          [id, { id, vector: [0], payload: { store_name: 'next' } }],
        ]),
      });
    }
    const opts = { url: stub.baseUrl };
    stub.failOn = ({ method, path }) =>
      method === 'PUT' && path === `/collections/${original}`;
    await assert.rejects(
      migrateQdrantMultivectors({ ...opts, collection: original }),
      /HTTP 500/,
    );
    stub.failOn = undefined;
    assert.ok(!stub.collections.has(original));
    const temporary = temporaryCollectionName(original);
    assert.equal(stub.aliases.get('read_docs'), temporary);
    assert.deepEqual(
      [...(stub.collections.get(temporary)?.points.values() ?? [])],
      [{ ...point, vector: [[1, 0]] }],
    );
    await releaseAfterSettledWrite({ ...opts, collection: original });

    const expected = [
      {
        collection: original,
        temporaryCollection: temporary,
        action: 'resume',
      },
      ...(useCatalog || collection
        ? [
            {
              collection: 'next',
              temporaryCollection: temporaryCollectionName('next'),
              action: 'migrate',
            },
          ]
        : []),
    ];
    const beforeDryRun = stub.requests.length;
    assert.deepEqual(
      await migrateQdrantMultivectors({ ...opts, collection, dryRun: true }),
      expected,
    );
    assert.ok(
      stub.requests
        .slice(beforeDryRun)
        .every(
          ({ method, path }) =>
            method === 'GET' ||
            (method === 'POST' && path.endsWith('/points/scroll')),
        ),
    );
    assert.ok(!stub.collections.has(original));
    assert.equal(stub.aliases.get('read_docs'), temporary);

    const start = stub.requests.length;
    assert.deepEqual(
      await migrateQdrantMultivectors({ ...opts, collection }),
      expected,
    );
    const requests = stub.requests.slice(start);
    if (useCatalog || collection) {
      const finished = requests.findIndex(
        ({ method, path }) =>
          method === 'DELETE' && path === `/collections/${temporary}`,
      );
      const next = requests.findIndex(
        ({ method, path }) => method === 'GET' && path === '/collections/next',
      );
      assert.ok(finished >= 0 && next > finished);
    }
    assert.ok(!stub.collections.has(temporary));
    assert.deepEqual(
      stub.collections.get(original)?.points,
      new Map([[id, { ...point, vector: [[1, 0]] }]]),
    );
    assert.deepEqual(
      stub.collections.get(original)?.payloadSchema,
      payloadSchema,
    );
    assert.equal(stub.aliases.get('read_docs'), original);
  });
}

test('an unreadable recovery marker blocks migration and leaves the temporary collection intact', async (t) => {
  const stub = await startQdrantStub();
  t.after(() => stub.close());
  const collection = 'next';
  const temporary = temporaryCollectionName('docs');
  const id = await deterministicUUID('legacy');
  const backup = {
    size: 2,
    multivector: true,
    sparseVectors: { __rag_multivector_migration_marker__: {} },
    points: new Map([
      [id, { id, vector: [[1, 0]], payload: { text: 'saved text' } }],
    ]),
  };
  stub.collections.set(temporary, backup);
  stub.collections.set(collection, { size: 2, points: new Map() });
  for (const dryRun of [false, true]) {
    await assert.rejects(
      migrateQdrantMultivectors({ url: stub.baseUrl, collection, dryRun }),
      {
        code: 'RAG_MIGRATION_ERROR',
        message: `Cannot read the original collection name from "${temporary}"`,
      },
    );
  }
  assert.equal(stub.collections.get(temporary), backup);
  assert.ok(!stub.collections.get(collection)?.multivector);
  assert.ok(
    stub.requests.every(
      ({ method, path }) =>
        method === 'GET' ||
        path === `/collections/${MIGRATION_LOCK_COLLECTION}`,
    ),
  );
  assert.ok(!stub.collections.has(MIGRATION_LOCK_COLLECTION));
});

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

test('custom shard keys are created before payload indexes and retain points with shared IDs', async (t) => {
  const stub = await startQdrantStub();
  t.after(() => stub.close());
  const id = await deterministicUUID('same');
  const point = { id, vector: [1, 0], payload: { text: 'west' } };
  const payloadSchema = { text: { data_type: 'keyword' } };
  stub.collections.set('geo', {
    size: 2,
    points: new Map(),
    payloadSchema,
    shards: new Map([
      ['west', new Map([[id, point]])],
      ['east', new Map([[id, { ...point, payload: { text: 'east' } }]])],
    ]),
  });
  const [{ temporaryCollection }] = await migrateQdrantMultivectors({
    url: stub.baseUrl,
    collection: 'geo',
  });
  for (const name of [temporaryCollection, 'geo']) {
    const path = `/collections/${name}`;
    assert.deepEqual(
      stub.requests
        .filter(
          ({ method, path: requested }) =>
            method === 'PUT' &&
            (requested === `${path}/shards` || requested === `${path}/index`),
        )
        .map(({ path: requested }) => requested),
      [`${path}/shards`, `${path}/shards`, `${path}/index`],
    );
  }
  const collection = stub.collections.get('geo');
  assert.deepEqual(collection?.payloadSchema, payloadSchema);
  const shards = collection?.shards;
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

test('a shardless custom collection retains its acknowledged payload index schema', async (t) => {
  const stub = await startQdrantStub();
  t.after(() => stub.close());
  const payloadSchema = { text: { data_type: 'keyword' } };
  stub.collections.set('geo', {
    size: 2,
    points: new Map(),
    shards: new Map(),
    payloadSchema,
  });
  await migrateQdrantMultivectors({ url: stub.baseUrl, collection: 'geo' });
  assert.deepEqual([...stub.collections.keys()], ['geo']);
  assert.equal(stub.collections.get('geo')?.multivector, true);
  assert.deepEqual(stub.collections.get('geo')?.payloadSchema, payloadSchema);
  assert.equal(stub.collections.get('geo')?.shards?.size, 0);
});
