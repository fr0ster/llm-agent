import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { test } from 'node:test';
import {
  migrateQdrantMultivectors,
  type QdrantMultivectorMigrationLockStatus,
  releaseQdrantMultivectorMigrationLock,
} from '../index.js';
import { MIGRATION_LOCK_COLLECTION, MIGRATION_PREFIX } from '../multivector.js';
import { type QdrantStub, startQdrantStub } from './qdrant-stub.js';

const lockPath = `/collections/${MIGRATION_LOCK_COLLECTION}`;
const docsBackup = `${MIGRATION_PREFIX}${createHash('sha256').update('docs').digest('hex')}`;
const originalPath = '/collections/docs';
const backupPath = `/collections/${docsBackup}`;
const point = { id: randomUUID(), vector: [1, 0], payload: { text: 'saved' } };

function seedDocs(stub: QdrantStub): void {
  stub.collections.set('docs', {
    size: 2,
    points: new Map([[point.id, point]]),
  });
}

function seedLock(stub: QdrantStub, token: string): void {
  stub.collections.set(MIGRATION_LOCK_COLLECTION, {
    size: 1,
    vectorConfig: { [`owner-${token}`]: { size: 1, distance: 'Dot' } },
    points: new Map(),
  });
}

test('a concurrent migration of another collection cannot recover an active backup', async (t) => {
  const stub = await startQdrantStub();
  t.after(() => stub.close());
  seedDocs(stub);
  stub.collections.set('next', { size: 2, points: new Map() });
  stub.aliases.set('read_docs', 'docs');
  const gate = new EventEmitter();
  const paused = once(gate, 'paused');
  stub.beforeRequest = async ({ method, path }) => {
    if (
      method !== 'GET' ||
      path !== `${originalPath}/aliases` ||
      !stub.collections.has(docsBackup)
    )
      return;
    stub.beforeRequest = undefined;
    const resume = once(gate, 'resume');
    gate.emit('paused');
    await resume;
  };

  const url = stub.baseUrl;
  const first = migrateQdrantMultivectors({ url, collection: 'docs' });
  try {
    assert.deepEqual(await Promise.race([paused, first]), []);
    assert.deepEqual(stub.collections.get(docsBackup)?.points.get(point.id), {
      ...point,
      vector: [[1, 0]],
    });
    const from = stub.requests.length;
    await assert.rejects(
      migrateQdrantMultivectors({ url, collection: 'next' }),
      /HTTP 409.*is held by token/,
    );
    assert.deepEqual(
      stub.requests.slice(from).map(({ method, path }) => [method, path]),
      [
        ['PUT', lockPath],
        ['GET', lockPath],
      ],
    );
  } finally {
    gate.emit('resume');
    await first;
  }
  assert.deepEqual([...stub.collections.keys()].sort(), ['docs', 'next']);
  assert.deepEqual(stub.collections.get('docs')?.points.get(point.id), {
    ...point,
    vector: [[1, 0]],
  });
  assert.equal(stub.aliases.get('read_docs'), 'docs');
  assert.ok(!stub.collections.get('next')?.multivector);
});

test('HTTP 500 deleting the original retains the lock and the verified backup', async (t) => {
  const stub = await startQdrantStub();
  t.after(() => stub.close());
  seedDocs(stub);
  stub.failOn = ({ method, path }) =>
    method === 'DELETE' && path === originalPath;
  const options = { url: stub.baseUrl, collection: 'docs' };
  let token: string | undefined;
  await assert.rejects(migrateQdrantMultivectors(options), (error: Error) => {
    assert.match(error.message, /HTTP 500.*was retained/);
    assert.match(error.message, /all pending Qdrant operations have settled/);
    token = /--release-lock ([a-f0-9-]+)/.exec(error.message)?.[1];
    return true;
  });
  assert.ok(token);
  assert.ok(stub.collections.has(MIGRATION_LOCK_COLLECTION));
  assert.ok(stub.collections.get('docs')?.points.has(point.id));
  assert.deepEqual(stub.collections.get(docsBackup)?.points.get(point.id), {
    ...point,
    vector: [[1, 0]],
  });
  assert.ok(
    !stub.requests.some(
      ({ method, path }) => method === 'DELETE' && path === lockPath,
    ),
  );
  stub.failOn = undefined;
  await releaseQdrantMultivectorMigrationLock(options, token);
  assert.equal((await migrateQdrantMultivectors(options))[0].action, 'resume');
  assert.deepEqual([...stub.collections.keys()], ['docs']);
});

for (const [status, error] of [
  [400, 'Deserialize error in query parameters: invalid timeout'],
  [422, 'Validation error in query parameters: timeout must be at least 1'],
] as const) {
  test(`a definite HTTP ${status} rejection releases the lock`, async (t) => {
    const stub = await startQdrantStub();
    t.after(() => stub.close());
    seedDocs(stub);
    stub.failOn = ({ method, path }) =>
      method === 'DELETE' &&
      path === originalPath && {
        status,
        body: { result: null, status: { error }, time: 0 },
      };
    const options = { url: stub.baseUrl, collection: 'docs' };
    await assert.rejects(
      migrateQdrantMultivectors(options),
      new RegExp(`DELETE ${originalPath} failed \\(HTTP ${status}`),
    );
    assert.ok(!stub.collections.has(MIGRATION_LOCK_COLLECTION));
    assert.ok(stub.collections.get('docs')?.points.has(point.id));
    assert.ok(stub.collections.get(docsBackup)?.points.has(point.id));
    stub.failOn = undefined;
    assert.equal(
      (await migrateQdrantMultivectors(options))[0].action,
      'resume',
    );
  });
}

test('a Qdrant duplicate collection conflict releases the acquired lock', async (t) => {
  const stub = await startQdrantStub();
  t.after(() => stub.close());
  seedDocs(stub);
  stub.beforeRequest = ({ method, path }) => {
    if (method === 'PUT' && path === backupPath) {
      stub.collections.set(docsBackup, { size: 2, points: new Map() });
    }
  };
  await assert.rejects(
    migrateQdrantMultivectors({ url: stub.baseUrl, collection: 'docs' }),
    /failed \(HTTP 409.*already exists/,
  );
  assert.ok(!stub.collections.has(MIGRATION_LOCK_COLLECTION));
  assert.deepEqual(stub.collections.get('docs')?.points.get(point.id), point);
});

for (const [failure, expected] of [
  ['disconnect', /fetch failed.*was retained/],
  [200, /HTTP 200.*was retained/],
  [202, /HTTP 202.*was retained/],
  [400, /HTTP 400.*was retained/],
  [404, /HTTP 404.*was retained/],
  [504, /HTTP 504.*was retained/],
] as const) {
  test(`an unconfirmed original DELETE (${failure}) keeps the lock`, async (t) => {
    const stub = await startQdrantStub();
    t.after(() => stub.close());
    seedDocs(stub);
    stub.failOn = ({ method, path }) =>
      method === 'DELETE' && path === originalPath && failure;
    await assert.rejects(
      migrateQdrantMultivectors({ url: stub.baseUrl, collection: 'docs' }),
      expected,
    );
    assert.ok(stub.collections.has(MIGRATION_LOCK_COLLECTION));
    assert.ok(stub.collections.get(docsBackup)?.points.has(point.id));
    assert.equal(stub.requests.at(-1)?.path, originalPath);
  });
}

test('a delayed DELETE cannot destroy recovered data after another run is refused', async (t) => {
  const stub = await startQdrantStub();
  t.after(() => stub.close());
  seedDocs(stub);
  stub.collections.set('next', { size: 2, points: new Map() });
  stub.aliases.set('read_docs', 'docs');
  const fetch = globalThis.fetch;
  const url = stub.baseUrl;
  let finishDelete: (() => Promise<Response>) | undefined;
  t.mock.method(
    globalThis,
    'fetch',
    async (...args: Parameters<typeof fetch>) => {
      if (
        !finishDelete &&
        args[0] === `${url}${originalPath}` &&
        args[1]?.method === 'DELETE'
      ) {
        finishDelete = () => fetch(...args);
        return new Response('Waiting for consensus operation commit failed', {
          status: 500,
        });
      }
      return fetch(...args);
    },
  );

  await assert.rejects(
    migrateQdrantMultivectors({ url, collection: 'docs' }),
    /HTTP 500.*was retained/,
  );
  assert.ok(finishDelete);
  const from = stub.requests.length;
  await assert.rejects(
    migrateQdrantMultivectors({ url, collection: 'next' }),
    /HTTP 409.*is held by token/,
  );
  assert.deepEqual(
    stub.requests.slice(from).map(({ method, path }) => [method, path]),
    [
      ['PUT', lockPath],
      ['GET', lockPath],
    ],
  );

  assert.ok((await finishDelete()).ok);
  assert.ok(!stub.collections.has('docs'));
  assert.equal(stub.aliases.get('read_docs'), docsBackup);
  assert.deepEqual(stub.collections.get(docsBackup)?.points.get(point.id), {
    ...point,
    vector: [[1, 0]],
  });

  let token: string | null = null;
  await migrateQdrantMultivectors({
    url,
    collection: 'docs',
    dryRun: true,
    onLockStatus: (status) => {
      if (status.locked) token = status.ownerToken;
    },
  });
  assert.ok(token);
  await releaseQdrantMultivectorMigrationLock({ url }, token);
  assert.equal(
    (await migrateQdrantMultivectors({ url, collection: 'docs' }))[0].action,
    'resume',
  );
  assert.deepEqual(stub.collections.get('docs')?.points.get(point.id), {
    ...point,
    vector: [[1, 0]],
  });
  assert.equal(stub.aliases.get('read_docs'), 'docs');
  assert.ok(!stub.collections.has(docsBackup));
});

for (const abort of [true, false]) {
  test(`a delayed HTTP 429 DELETE fences out another migration after ${abort ? 'abort' : 'a successful retry'}`, async (t) => {
    const stub = await startQdrantStub();
    t.after(() => stub.close());
    seedDocs(stub);
    stub.collections.set('next', { size: 2, points: new Map() });
    const controller = new AbortController();
    const fetch = globalThis.fetch;
    const url = stub.baseUrl;
    let finishDelete: (() => Promise<Response>) | undefined;
    t.mock.method(
      globalThis,
      'fetch',
      async (...args: Parameters<typeof fetch>) => {
        if (
          !finishDelete &&
          args[0] === `${url}${originalPath}` &&
          args[1]?.method === 'DELETE'
        ) {
          finishDelete = () => fetch(...args);
          return new Response(
            new ReadableStream({
              cancel: () => {
                if (abort) controller.abort();
              },
            }),
            { status: 429, headers: { 'Retry-After': '0' } },
          );
        }
        return fetch(...args);
      },
    );

    await assert.rejects(
      migrateQdrantMultivectors({
        url,
        collection: 'docs',
        signal: controller.signal,
      }),
      abort
        ? /HTTP 429.*AbortError.*was retained/
        : /HTTP 429.*retry succeeded.*was retained/,
    );
    assert.equal(stub.collections.has('docs'), abort);
    assert.ok(finishDelete);
    const from = stub.requests.length;
    await assert.rejects(
      migrateQdrantMultivectors({ url, collection: 'next' }),
      /HTTP 409.*is held by token/,
    );
    assert.deepEqual(
      stub.requests.slice(from).map(({ method, path }) => [method, path]),
      [
        ['PUT', lockPath],
        ['GET', lockPath],
      ],
    );
    assert.ok((await finishDelete()).ok);
    assert.ok(!stub.collections.has('docs'));
    assert.deepEqual(stub.collections.get(docsBackup)?.points.get(point.id), {
      ...point,
      vector: [[1, 0]],
    });
  });
}

test('a stale lock blocks recovery until the matching token is explicitly released', async (t) => {
  const stub = await startQdrantStub();
  t.after(() => stub.close());
  const token = randomUUID();
  seedDocs(stub);
  seedLock(stub, token);
  const options = { url: stub.baseUrl, collection: 'docs' };
  await assert.rejects(migrateQdrantMultivectors(options), (error: Error) => {
    assert.ok(error.message.includes(MIGRATION_LOCK_COLLECTION));
    assert.ok(error.message.includes(`held by token "${token}"`));
    assert.ok(
      error.message.includes(
        'confirming no migration or release process is running',
      ),
    );
    assert.ok(error.message.includes(`--release-lock ${token}`));
    return true;
  });
  assert.deepEqual(
    stub.requests.map(({ path }) => path),
    [lockPath, lockPath],
  );
  await assert.rejects(
    releaseQdrantMultivectorMigrationLock(options, randomUUID()),
    /ownership could not be verified/,
  );
  assert.ok(stub.collections.has(MIGRATION_LOCK_COLLECTION));
  assert.ok(!stub.requests.some(({ method }) => method === 'DELETE'));
  await releaseQdrantMultivectorMigrationLock(options, token);
  assert.ok(!stub.collections.has(MIGRATION_LOCK_COLLECTION));
  assert.deepEqual(stub.collections.get('docs')?.points.get(point.id), point);
});

for (const [label, path, withAlias, replace] of [
  ['reassigning aliases', `${backupPath}/points/count`, true, true],
  ['deleting the original', `${backupPath}/points/count`, false, false],
  ['deleting the backup', `${originalPath}/points/count`, false, true],
] as const) {
  test(`fencing retains both copies after losing the lock before ${label}`, async (t) => {
    const stub = await startQdrantStub();
    t.after(() => stub.close());
    seedDocs(stub);
    if (withAlias) stub.aliases.set('read_docs', 'docs');
    const replacement = randomUUID();
    let lost = false;
    let nextRequest = 0;
    stub.beforeRequest = (request) => {
      if (
        lost ||
        request.path !== path ||
        (path.startsWith(originalPath) &&
          !stub.collections.get('docs')?.multivector)
      )
        return;
      lost = true;
      nextRequest = stub.requests.length;
      if (replace) seedLock(stub, replacement);
      else stub.collections.delete(MIGRATION_LOCK_COLLECTION);
    };
    await assert.rejects(
      migrateQdrantMultivectors({ url: stub.baseUrl, collection: 'docs' }),
      /ownership could not be verified/,
    );
    assert.ok(lost);
    assert.ok(
      stub.requests.slice(nextRequest).every(({ method }) => method === 'GET'),
    );
    assert.equal(stub.collections.has(MIGRATION_LOCK_COLLECTION), replace);
    assert.ok(stub.collections.get('docs')?.points.has(point.id));
    assert.ok(stub.collections.get(docsBackup)?.points.has(point.id));
    if (withAlias) assert.equal(stub.aliases.get('read_docs'), 'docs');
  });
}

test('a throttled delete checks the lock again before retrying', async (t) => {
  const stub = await startQdrantStub();
  t.after(() => stub.close());
  seedDocs(stub);
  stub.throttle = ({ method, path }) => {
    if (method !== 'DELETE' || path !== originalPath) return false;
    seedLock(stub, randomUUID());
    stub.throttle = undefined;
    return true;
  };
  await assert.rejects(
    migrateQdrantMultivectors({ url: stub.baseUrl, collection: 'docs' }),
    /ownership could not be verified/,
  );
  assert.equal(
    stub.requests.filter(
      ({ method, path }) => method === 'DELETE' && path === originalPath,
    ).length,
    1,
  );
  assert.ok(stub.collections.get('docs')?.points.has(point.id));
  assert.ok(stub.collections.get(docsBackup)?.points.has(point.id));
  assert.ok(stub.collections.has(MIGRATION_LOCK_COLLECTION));
});

test('a confirmed backup upsert after uncapped HTTP 429 retries releases the lock', async (t) => {
  const stub = await startQdrantStub();
  t.after(() => stub.close());
  seedDocs(stub);
  let attempts = 0;
  stub.throttle = ({ method, path }) =>
    method === 'PUT' && path === `${backupPath}/points` && ++attempts <= 12;
  await migrateQdrantMultivectors({ url: stub.baseUrl, collection: 'docs' });
  assert.equal(attempts, 13);
  assert.deepEqual([...stub.collections.keys()], ['docs']);
  assert.deepEqual(stub.collections.get('docs')?.points.get(point.id), {
    ...point,
    vector: [[1, 0]],
  });
});

test('a definite rejection of a retry leaves the earlier HTTP 429 write unconfirmed', async (t) => {
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
  await assert.rejects(
    migrateQdrantMultivectors({ url: stub.baseUrl, collection: 'docs' }),
    /HTTP 429.*HTTP 422.*was retained/,
  );
  assert.ok(stub.collections.has(MIGRATION_LOCK_COLLECTION));
  assert.equal(stub.requests.at(-1)?.path, `${backupPath}/points`);
});

test('an acknowledged payload index with a queued operation keeps the lock', async (t) => {
  const stub = await startQdrantStub();
  t.after(() => stub.close());
  stub.collections.set('docs', {
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
    migrateQdrantMultivectors({ url: stub.baseUrl, collection: 'docs' }),
    /HTTP 200.*acknowledged.*was retained/,
  );
  assert.ok(stub.collections.has(MIGRATION_LOCK_COLLECTION));
  assert.equal(stub.requests.at(-1)?.path, `${backupPath}/index`);
});

test('an unconfirmed write retains the lock even if the caller aborts', async (t) => {
  const stub = await startQdrantStub();
  t.after(() => stub.close());
  seedDocs(stub);
  const controller = new AbortController();
  stub.failOn = ({ method, path }) => {
    if (method !== 'DELETE' || path !== originalPath) return false;
    controller.abort();
    return 408;
  };
  await assert.rejects(
    migrateQdrantMultivectors({
      url: stub.baseUrl,
      collection: 'docs',
      signal: controller.signal,
    }),
    /HTTP 408.*was retained/,
  );
  assert.ok(stub.collections.has(MIGRATION_LOCK_COLLECTION));
  assert.ok(stub.collections.get('docs')?.points.has(point.id));
  assert.ok(stub.collections.get(docsBackup)?.points.has(point.id));
});

test('dry run reports both free and held lock states without taking the lock', async (t) => {
  const stub = await startQdrantStub();
  t.after(() => stub.close());
  seedDocs(stub);
  const statuses: QdrantMultivectorMigrationLockStatus[] = [];
  const options = {
    url: stub.baseUrl,
    collection: 'docs',
    dryRun: true,
    onLockStatus: (status: QdrantMultivectorMigrationLockStatus) => {
      statuses.push(status);
    },
  };
  assert.equal((await migrateQdrantMultivectors(options))[0].action, 'migrate');
  assert.ok(!stub.collections.has(MIGRATION_LOCK_COLLECTION));
  const ownerToken = randomUUID();
  seedLock(stub, ownerToken);
  assert.equal((await migrateQdrantMultivectors(options))[0].action, 'migrate');
  assert.deepEqual(statuses, [
    { collection: MIGRATION_LOCK_COLLECTION, locked: false },
    { collection: MIGRATION_LOCK_COLLECTION, locked: true, ownerToken },
  ]);
  assert.ok(stub.requests.every(({ method }) => method === 'GET'));
});
