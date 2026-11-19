import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { migrateQdrantMultivectors } from '../index.js';
import { MIGRATION_PREFIX } from '../multivector.js';
import { type QdrantStub, startQdrantStub } from './qdrant-stub.js';

const collection = 'docs';
const temporaryCollection = `${MIGRATION_PREFIX}${createHash('sha256').update(collection).digest('hex')}`;
const originalPath = `/collections/${collection}`;
const backupPath = `/collections/${temporaryCollection}`;
const id = '67a1d998-b09f-4bfc-9849-7207045cb5f0';
const point = { id, vector: [1, 0], payload: { text: 'saved' } };
const converted = { ...point, vector: [[1, 0]] };

function seedDocs(stub: QdrantStub): void {
  stub.collections.set(collection, {
    size: 2,
    points: new Map([[id, point]]),
  });
  stub.aliases.set('read_docs', collection);
}

function assertRestored(stub: QdrantStub): void {
  assert.deepEqual([...stub.collections.keys()], [collection]);
  assert.deepEqual(
    stub.collections.get(collection)?.points,
    new Map([[id, converted]]),
  );
  assert.equal(stub.aliases.get('read_docs'), collection);
}

for (const [failure, expected] of [
  [429, /HTTP 429/],
  [500, /HTTP 500/],
  ['disconnect', /fetch failed/],
  [200, /HTTP 200/],
  [202, /HTTP 202/],
  [400, /HTTP 400/],
  [404, /HTTP 404/],
] as const) {
  test(`unconfirmed original DELETE (${failure}) stops and recovers after the delete settles`, async (t) => {
    const stub = await startQdrantStub();
    t.after(() => stub.close());
    seedDocs(stub);
    let deleteAt: number | undefined;
    stub.beforeRequest = ({ method, path }) => {
      if (method === 'DELETE' && path === originalPath)
        deleteAt ??= stub.requests.length - 1;
    };
    // Both injectors fail just the first DELETE, so an accidental retry can run.
    const firstDelete = ({ method, path }: { method: string; path: string }) =>
      method === 'DELETE' &&
      path === originalPath &&
      deleteAt === stub.requests.length - 1;
    stub.throttle = (request) => failure === 429 && firstDelete(request);
    stub.failOn = (request) => firstDelete(request) && failure;
    const options = { url: stub.baseUrl, collection };
    await assert.rejects(migrateQdrantMultivectors(options), (error: Error) => {
      assert.ok(
        error.message.startsWith(`Could not confirm DELETE ${originalPath}:`),
      );
      assert.match(error.message, expected);
      assert.match(
        error.message,
        /pending Qdrant operations have settled, rerun the same command to resume from the temporary collection/,
      );
      return true;
    });
    assert.notEqual(deleteAt, undefined);
    assert.deepEqual(
      stub.requests.slice(deleteAt).map(({ method, path }) => [method, path]),
      [['DELETE', originalPath]],
    );
    assert.deepEqual(
      stub.collections.get(temporaryCollection)?.points,
      new Map([[id, converted]]),
    );
    assert.equal(stub.aliases.get('read_docs'), temporaryCollection);

    // Apply the pending server operation after the client has stopped.
    assert.ok(stub.collections.delete(collection));
    assert.equal(
      (await migrateQdrantMultivectors(options))[0].action,
      'resume',
    );
    assertRestored(stub);
  });
}

for (const [status, error] of [
  [400, 'Deserialize error in query parameters: invalid input'],
  [400, 'Format error in body'],
  [422, 'Validation error in query parameters: invalid input'],
  [409, 'Wrong input: Collection `backup` already exists!'],
] as const) {
  test(`HTTP ${status} ${error.split(':')[0]} is a definite rejection`, async (t) => {
    const stub = await startQdrantStub();
    t.after(() => stub.close());
    seedDocs(stub);
    const [operation, target] =
      status === 409 ? ['PUT', backupPath] : ['DELETE', originalPath];
    stub.failOn = ({ method, path }) =>
      method === operation &&
      path === target && {
        status,
        body: { result: null, status: { error }, time: 0 },
      };
    const options = { url: stub.baseUrl, collection };
    await assert.rejects(migrateQdrantMultivectors(options), {
      code: 'RAG_MIGRATION_ERROR',
      message: new RegExp(`^${operation} ${target} failed \\(HTTP ${status}`),
    });
    assert.deepEqual(stub.collections.get(collection)?.points.get(id), point);
    stub.failOn = undefined;
    assert.equal(
      (await migrateQdrantMultivectors(options))[0].action,
      status === 409 ? 'migrate' : 'resume',
    );
    assertRestored(stub);
  });
}

test('a backup upsert retries identical HTTP 429 requests and leaves the verified backup for cleanup', async (t) => {
  const stub = await startQdrantStub();
  t.after(() => stub.close());
  seedDocs(stub);
  let attempts = 0;
  stub.throttle = ({ method, path }) =>
    method === 'PUT' && path === `${backupPath}/points` && ++attempts <= 12;
  const options = { url: stub.baseUrl, collection };
  assert.deepEqual(await migrateQdrantMultivectors(options), [
    {
      collection,
      temporaryCollection,
      action: 'migrate',
      temporaryCollectionRetained: true,
    },
  ]);
  const upserts = stub.requests.filter(
    ({ method, path }) => method === 'PUT' && path === `${backupPath}/points`,
  );
  assert.equal(attempts, 13);
  assert.equal(upserts.length, attempts);
  assert.deepEqual(
    upserts.map(({ body }) => body),
    Array(attempts).fill({ points: [converted] }),
  );
  assert.ok(
    !stub.requests.some(
      ({ method, path }) => method === 'DELETE' && path === backupPath,
    ),
  );
  for (const name of [collection, temporaryCollection])
    assert.deepEqual(
      stub.collections.get(name)?.points,
      new Map([[id, converted]]),
    );
  assert.equal(stub.aliases.get('read_docs'), collection);

  assert.deepEqual(await migrateQdrantMultivectors(options), [
    { collection, temporaryCollection, action: 'resume' },
  ]);
  assertRestored(stub);
});

test('a rejected backup upsert retry still reports the earlier HTTP 429 as unconfirmed', async (t) => {
  const stub = await startQdrantStub();
  t.after(() => stub.close());
  seedDocs(stub);
  stub.throttle = ({ method, path }) => {
    if (method !== 'PUT' || path !== `${backupPath}/points`) return false;
    stub.throttle = undefined;
    return true;
  };
  stub.failOn = ({ method, path }) =>
    method === 'PUT' &&
    path === `${backupPath}/points` && {
      status: 422,
      body: {
        result: null,
        status: { error: 'Validation error in body' },
        time: 0,
      },
    };
  const options = { url: stub.baseUrl, collection };
  await assert.rejects(
    migrateQdrantMultivectors(options),
    /Could not confirm PUT .*\/points\?.*HTTP 429.*HTTP 422/,
  );
  assert.equal(stub.requests.at(-1)?.path, `${backupPath}/points`);
  assert.ok(stub.collections.has(temporaryCollection));
  assert.deepEqual(stub.collections.get(collection)?.points.get(id), point);
  stub.failOn = undefined;
  await migrateQdrantMultivectors(options);
  assertRestored(stub);
});

for (const [method, path] of [
  ['PUT', backupPath],
  ['POST', '/collections/aliases'],
  ['PUT', originalPath],
  ['PUT', `${originalPath}/points`],
  ['DELETE', backupPath],
] as const) {
  test(`HTTP 429 on ${method} ${path} stops without retrying`, async (t) => {
    const stub = await startQdrantStub();
    t.after(() => stub.close());
    seedDocs(stub);
    let failedAt = -1;
    stub.throttle = (request) => {
      if (request.method !== method || request.path !== path) return false;
      failedAt = stub.requests.length - 1;
      stub.throttle = undefined;
      return true;
    };
    const options = { url: stub.baseUrl, collection };
    await assert.rejects(migrateQdrantMultivectors(options), (error: Error) => {
      assert.ok(
        error.message.startsWith(`Could not confirm ${method} ${path}`),
      );
      assert.match(error.message, /HTTP 429/);
      if (method === 'POST')
        assert.ok(
          error.message.includes(
            `move aliases "read_docs" from "docs" to "${temporaryCollection}"`,
          ),
        );
      return true;
    });
    assert.equal(failedAt, stub.requests.length - 1);
    if (method === 'DELETE') {
      // Cleanup may already have applied. It was sent after verifying the original.
      assert.ok(stub.collections.delete(temporaryCollection));
      assert.equal(
        (await migrateQdrantMultivectors(options))[0].action,
        'already-migrated',
      );
    } else {
      await migrateQdrantMultivectors(options);
    }
    assertRestored(stub);
  });
}

test('a partial alias move preserves discoverable aliases for the next run', async (t) => {
  const stub = await startQdrantStub();
  t.after(() => stub.close());
  seedDocs(stub);
  stub.aliases.set('other_docs', collection);
  stub.failOn = ({ method, path, body }) => {
    if (method !== 'POST' || path !== '/collections/aliases') return false;
    assert.deepEqual(body, {
      actions: ['read_docs', 'other_docs'].map((alias_name) => ({
        create_alias: { alias_name, collection_name: temporaryCollection },
      })),
    });
    stub.aliases.set('read_docs', temporaryCollection);
    return 500;
  };
  const options = { url: stub.baseUrl, collection };
  await assert.rejects(
    migrateQdrantMultivectors(options),
    /Could not confirm POST .*read_docs.*other_docs.*HTTP 500/,
  );
  assert.equal(stub.requests.at(-1)?.path, '/collections/aliases');
  stub.failOn = undefined;
  await migrateQdrantMultivectors(options);
  assert.equal(stub.aliases.get('other_docs'), collection);
  assertRestored(stub);
});

test('a later unconfirmed collection creation leaves previously verified backups intact', async (t) => {
  const stub = await startQdrantStub();
  t.after(() => stub.close());
  seedDocs(stub);
  stub.collections.set('next', { size: 2, points: new Map() });
  stub.collections.set('rag_collection_catalog', {
    size: 1,
    points: new Map(
      ['docs', 'next'].map((name) => [
        name,
        { id: name, vector: [0], payload: { store_name: name } },
      ]),
    ),
  });
  const nextBackup = `${MIGRATION_PREFIX}${createHash('sha256').update('next').digest('hex')}`;
  stub.failOn = ({ method, path }) =>
    method === 'PUT' && path === `/collections/${nextBackup}`;

  const options = { url: stub.baseUrl };
  await assert.rejects(
    migrateQdrantMultivectors(options),
    /Could not confirm PUT .*HTTP 500/,
  );
  assert.deepEqual(stub.collections.get(collection)?.points.get(id), converted);
  assert.deepEqual(
    stub.collections.get(temporaryCollection)?.points.get(id),
    converted,
  );
  assert.ok(
    !stub.requests.some(
      ({ method, path }) => method === 'DELETE' && path === backupPath,
    ),
  );

  stub.failOn = undefined;
  assert.deepEqual(
    (await migrateQdrantMultivectors(options)).map(({ collection, action }) => [
      collection,
      action,
    ]),
    [
      ['docs', 'resume'],
      ['next', 'migrate'],
    ],
  );
  assert.ok(!stub.collections.has(temporaryCollection));
  assert.ok(!stub.collections.has(nextBackup));
  assert.deepEqual(stub.collections.get(collection)?.points.get(id), converted);
});

test('an acknowledged payload index with a queued operation stops before further writes', async (t) => {
  const stub = await startQdrantStub();
  t.after(() => stub.close());
  stub.collections.set(collection, {
    size: 2,
    points: new Map(),
    shards: new Map(),
    payloadSchema: { text: { data_type: 'keyword' } },
  });
  stub.failOn = ({ method, path }) =>
    method === 'PUT' &&
    path === `${backupPath}/index` && {
      status: 200,
      body: {
        status: 'ok',
        result: { status: 'acknowledged', operation_id: 1 },
      },
    };
  await assert.rejects(
    migrateQdrantMultivectors({ url: stub.baseUrl, collection }),
    /Could not confirm PUT .*payload index "text".*HTTP 200.*acknowledged/,
  );
  assert.ok(stub.collections.has(temporaryCollection));
  assert.equal(stub.requests.at(-1)?.path, `${backupPath}/index`);
});

test('aborting an in-flight original DELETE reports the uncertain operation', async (t) => {
  const stub = await startQdrantStub();
  t.after(() => stub.close());
  seedDocs(stub);
  const controller = new AbortController();
  stub.failOn = ({ method, path }) => {
    if (method !== 'DELETE' || path !== originalPath) return false;
    controller.abort();
    return 'disconnect';
  };
  const options = { url: stub.baseUrl, collection };
  await assert.rejects(
    migrateQdrantMultivectors({ ...options, signal: controller.signal }),
    /Could not confirm DELETE \/collections\/docs: AbortError/,
  );
  assert.equal(stub.requests.at(-1)?.path, originalPath);
  assert.ok(stub.collections.has(temporaryCollection));
  stub.failOn = undefined;
  await migrateQdrantMultivectors(options);
  assertRestored(stub);
});
