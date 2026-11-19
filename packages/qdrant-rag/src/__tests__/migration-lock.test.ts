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

test('a failed migration releases its lock and retains its backup for recovery', async (t) => {
  const stub = await startQdrantStub();
  t.after(() => stub.close());
  seedDocs(stub);
  stub.failOn = ({ method, path }) =>
    method === 'DELETE' && path === originalPath;
  const options = { url: stub.baseUrl, collection: 'docs' };
  await assert.rejects(migrateQdrantMultivectors(options), /HTTP 500/);
  assert.ok(!stub.collections.has(MIGRATION_LOCK_COLLECTION));
  assert.ok(stub.collections.has(docsBackup));
  stub.failOn = undefined;
  assert.equal((await migrateQdrantMultivectors(options))[0].action, 'resume');
  assert.deepEqual([...stub.collections.keys()], ['docs']);
});

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
