import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { RagError } from '@mcp-abap-adt/llm-agent';
import {
  migrateQdrantMultivectors,
  RAG_MIGRATION_PRECONDITION,
  RAG_MIGRATION_REJECTED,
  RAG_MIGRATION_UNCONFIRMED,
  RAG_MIGRATION_VERIFICATION,
} from '../index.js';
import { MIGRATION_PREFIX } from '../multivector.js';
import { type QdrantStub, startQdrantStub } from './qdrant-stub.js';

const collection = 'docs';
const backupName = (name: string) =>
  MIGRATION_PREFIX + createHash('sha256').update(name).digest('hex');
const temporaryCollection = backupName(collection);
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
      assert.ok(error instanceof RagError);
      assert.equal(error.code, RAG_MIGRATION_UNCONFIRMED);
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
      code: RAG_MIGRATION_REJECTED,
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

for (const [status, source, body] of [
  [
    401,
    'middleware',
    'Must provide an API key or an Authorization bearer token',
  ],
  [403, 'middleware', 'Invalid JWT, stateful validation failed'],
  [
    403,
    'RBAC',
    { status: { error: 'Forbidden: Global manage access is required' } },
  ],
] as const) {
  test(`HTTP ${status} from ${source} rejects backup creation without creating a collection`, async (t) => {
    const stub = await startQdrantStub();
    t.after(() => stub.close());
    seedDocs(stub);
    stub.failOn = ({ method, path }) =>
      method === 'PUT' && path === backupPath && { status, body };

    await assert.rejects(
      migrateQdrantMultivectors({ url: stub.baseUrl, collection }),
      {
        code: RAG_MIGRATION_REJECTED,
        message: new RegExp(
          `^PUT ${backupPath} failed \\(HTTP ${status}.*Fix the API key or its permissions, then rerun`,
        ),
      },
    );
    assert.deepEqual([...stub.collections.keys()], [collection]);
    assert.deepEqual(stub.collections.get(collection)?.points.get(id), point);
    assert.equal(stub.aliases.get('read_docs'), collection);
    assert.deepEqual(
      stub.requests
        .filter(({ method }) => method !== 'GET')
        .map(({ method, path }) => [method, path]),
      [['PUT', backupPath]],
    );
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

for (const [status, body] of [
  [
    422,
    { result: null, status: { error: 'Validation error in body' }, time: 0 },
  ],
  [403, 'Invalid JWT, stateful validation failed'],
] as const) {
  test(`HTTP ${status} on a backup upsert retry leaves the earlier HTTP 429 unconfirmed`, async (t) => {
    const stub = await startQdrantStub();
    t.after(() => stub.close());
    seedDocs(stub);
    const upsertPath = `${backupPath}/points`;
    stub.throttle = ({ method, path }) => {
      if (method !== 'PUT' || path !== upsertPath) return false;
      stub.throttle = undefined;
      return true;
    };
    stub.failOn = ({ method, path }) =>
      method === 'PUT' && path === upsertPath && { status, body };
    const options = { url: stub.baseUrl, collection };
    await assert.rejects(migrateQdrantMultivectors(options), {
      code: RAG_MIGRATION_UNCONFIRMED,
      message: new RegExp(
        `^Could not confirm PUT ${upsertPath}\\?.*HTTP 429.*HTTP ${status}`,
      ),
    });
    const [first, retry, ...otherUpserts] = stub.requests.filter(
      ({ method, path }) => method === 'PUT' && path === upsertPath,
    );
    assert.ok(first);
    assert.deepEqual(retry, first);
    assert.deepEqual(otherUpserts, []);
    assert.equal(stub.requests.at(-1), retry);
    assert.ok(stub.collections.has(temporaryCollection));
    assert.deepEqual(stub.collections.get(collection)?.points.get(id), point);
    stub.failOn = undefined;
    await migrateQdrantMultivectors(options);
    assertRestored(stub);
  });
}

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

test('HTTP 403 from a write lock after saving an index schema leaves the operation unconfirmed', async (t) => {
  const stub = await startQdrantStub();
  t.after(() => stub.close());
  seedDocs(stub);
  const schema = { text: { data_type: 'keyword' } };
  const source = stub.collections.get(collection);
  assert.ok(source);
  source.payloadSchema = schema;
  const indexPath = `${backupPath}/index`;
  stub.failOn = ({ method, path }) => {
    if (method !== 'PUT' || path !== indexPath) return false;
    const backup = stub.collections.get(temporaryCollection);
    assert.ok(backup);
    backup.payloadSchema = schema;
    return {
      status: 403,
      body: {
        result: null,
        status: { error: 'Storage locked: Write operations are forbidden' },
        time: 0.01,
      },
    };
  };

  await assert.rejects(
    migrateQdrantMultivectors({ url: stub.baseUrl, collection }),
    {
      code: RAG_MIGRATION_UNCONFIRMED,
      message:
        /Could not confirm PUT .*payload index "text".*HTTP 403.*Storage locked/,
    },
  );
  assert.deepEqual(
    stub.collections.get(temporaryCollection)?.payloadSchema,
    schema,
  );
  assert.deepEqual(source.points.get(id), point);
  assert.equal(stub.requests.at(-1)?.path, indexPath);
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

async function interruptBeforeRestore(stub: QdrantStub): Promise<void> {
  seedDocs(stub);
  stub.failOn = ({ method, path }) => method === 'PUT' && path === originalPath;
  await assert.rejects(
    migrateQdrantMultivectors({ url: stub.baseUrl, collection }),
    /HTTP 500/,
  );
  stub.failOn = undefined;
  stub.requests.length = 0;
}

test('an explicit list resumes leftovers once, then processes physical collections in order', async (t) => {
  const stub = await startQdrantStub();
  t.after(() => stub.close());
  await interruptBeforeRestore(stub);
  for (const name of ['catalogued', 'standalone'])
    stub.collections.set(name, { size: 2, points: new Map() });

  assert.deepEqual(
    await migrateQdrantMultivectors({
      url: stub.baseUrl,
      collections: ['standalone', 'optional', 'docs', 'catalogued'],
    }),
    [
      { collection, temporaryCollection, action: 'resume' },
      {
        collection: 'standalone',
        temporaryCollection: backupName('standalone'),
        action: 'migrate',
      },
      {
        collection: 'optional',
        temporaryCollection: backupName('optional'),
        action: 'absent',
      },
      {
        collection: 'catalogued',
        temporaryCollection: backupName('catalogued'),
        action: 'migrate',
      },
    ],
  );
  assert.deepEqual(
    stub.requests
      .filter(
        ({ method, path }) =>
          method === 'GET' &&
          [
            '/collections',
            originalPath,
            '/collections/standalone',
            '/collections/optional',
            '/collections/catalogued',
            '/collections/rag_collection_catalog',
          ].includes(path),
      )
      .map(({ path }) => path),
    [
      '/collections',
      originalPath,
      '/collections/standalone',
      '/collections/optional',
      '/collections/catalogued',
    ],
  );
  assert.equal(
    stub.requests.filter(
      ({ method, path }) =>
        method === 'PUT' && path === `${originalPath}/points`,
    ).length,
    1,
  );
});

test('an empty list performs recovery only', async (t) => {
  const stub = await startQdrantStub();
  t.after(() => stub.close());
  await interruptBeforeRestore(stub);
  stub.collections.set('untouched', { size: 2, points: new Map() });
  assert.deepEqual(
    await migrateQdrantMultivectors({ url: stub.baseUrl, collections: [] }),
    [{ collection, temporaryCollection, action: 'resume' }],
  );
  assert.equal(stub.collections.get('untouched')?.multivector, undefined);
  assert.equal(stub.collections.has(temporaryCollection), false);
  assert.ok(
    stub.requests.every(
      ({ path }) =>
        !path.includes('rag_collection_catalog') && !path.includes('untouched'),
    ),
  );
});

test('mutually exclusive selectors are rejected before making requests', async (t) => {
  const stub = await startQdrantStub();
  t.after(() => stub.close());
  for (const selection of [
    { collection, collections: [] },
    { collections: [], catalogCollection: 'catalog' },
    { collection, catalogCollection: 'catalog' },
  ]) {
    await assert.rejects(
      migrateQdrantMultivectors({ url: stub.baseUrl, ...selection }),
      { code: RAG_MIGRATION_PRECONDITION, message: /Select collections/ },
    );
  }
  assert.deepEqual(stub.requests, []);
});

test('an alias is a precondition error and stops the list at that collection', async (t) => {
  const stub = await startQdrantStub();
  t.after(() => stub.close());
  seedDocs(stub);
  stub.collections.set('later', { size: 2, points: new Map() });
  await assert.rejects(
    migrateQdrantMultivectors({
      url: stub.baseUrl,
      collections: ['docs', 'read_docs', 'later'],
    }),
    {
      code: RAG_MIGRATION_PRECONDITION,
      message: /read_docs.*physical collection name/,
    },
  );
  assert.equal(stub.collections.get('docs')?.multivector, true);
  assert.ok(stub.collections.has(temporaryCollection));
  assert.ok(stub.requests.every(({ path }) => path !== '/collections/later'));
});

for (const [stage, target, field] of [
  ['backup', backupPath, 'payload'],
  ['backup', backupPath, 'shard_key'],
  ['restored original', originalPath, 'dense'],
  ['restored original', originalPath, 'sparse'],
] as const) {
  test(`migration detects ${field} corruption in the middle of a page in the ${stage}`, async (t) => {
    const stub = await startQdrantStub();
    t.after(() => stub.close());
    const ids = ['000', '001', '002'];
    const points = ids.map((id) => ({
      id,
      payload: { text: 'saved' },
      vector: { dense: [1, 0], sparse: { indices: [3], values: [1] } },
    }));
    stub.collections.set(collection, {
      size: 2,
      vectorConfig: { dense: { size: 2, distance: 'Cosine' } },
      sparseVectors: { sparse: {} },
      points: new Map(),
      shards: new Map([['west', new Map(points.map((p) => [p.id, p]))]]),
    });
    stub.failOn = ({ method, path, body }) => {
      if (method !== 'POST' || path !== `${target}/points`) return false;
      const { ids: requested } = body as { ids: string[] };
      return {
        status: 200,
        body: {
          result: points
            .filter(({ id }) => requested.includes(id))
            .map((p) => {
              const corrupt = p.id === ids[1];
              return {
                ...p,
                shard_key: corrupt && field === 'shard_key' ? 'east' : 'west',
                payload:
                  corrupt && field === 'payload'
                    ? { text: 'altered' }
                    : p.payload,
                vector: {
                  dense: [
                    corrupt && field === 'dense' ? [0, 1] : p.vector.dense,
                  ],
                  sparse:
                    corrupt && field === 'sparse'
                      ? { indices: [3], values: [2] }
                      : p.vector.sparse,
                },
              };
            }),
        },
      };
    };
    await assert.rejects(
      migrateQdrantMultivectors({ url: stub.baseUrl, collection }),
      {
        code: RAG_MIGRATION_VERIFICATION,
        message: /001.*did not verify/,
      },
    );
    assert.ok(stub.collections.has(temporaryCollection));
    assert.equal(stub.requests.at(-1)?.path, `${target}/points`);
    if (stage === 'backup')
      assert.equal(stub.collections.get(collection)?.multivector, undefined);
  });
}

test('reads and verifies all points across multiple pages with exact counts', async (t) => {
  const stub = await startQdrantStub();
  t.after(() => stub.close());
  const ids = Array.from({ length: 259 }, (_, i) => String(i).padStart(3, '0'));
  stub.collections.set(collection, {
    size: 2,
    points: new Map(ids.map((id) => [id, { ...point, id }])),
  });
  await migrateQdrantMultivectors({ url: stub.baseUrl, collection });

  for (const path of [backupPath, originalPath]) {
    const reads = stub.requests.filter(
      ({ method, path: requested }) =>
        method === 'POST' && requested === `${path}/points`,
    );
    assert.deepEqual(
      reads.map(({ body }) => (body as { ids: string[] }).ids),
      [ids.slice(0, 256), ids.slice(256)],
    );
  }
  const pointReads = stub.requests.filter(({ method }) => method === 'POST');
  assert.ok(pointReads.every(({ search }) => search === '?consistency=all'));
  const counts = pointReads.filter(({ path }) => path.endsWith('/count'));
  assert.equal(counts.length, 4);
  assert.ok(counts.every(({ body }) => (body as { exact: boolean }).exact));
});

test('an exact count mismatch is a verification error', async (t) => {
  const stub = await startQdrantStub();
  t.after(() => stub.close());
  seedDocs(stub);
  stub.failOn = ({ path }) =>
    path === `${backupPath}/points/count` && {
      status: 200,
      body: { result: { count: 2 } },
    };
  await assert.rejects(
    migrateQdrantMultivectors({ url: stub.baseUrl, collection }),
    {
      code: RAG_MIGRATION_VERIFICATION,
      message: /Point count did not verify \(expected 1, found 2\)/,
    },
  );
  assert.ok(stub.collections.has(temporaryCollection));
  assert.deepEqual(stub.collections.get(collection)?.points.get(id), point);
});

test('an unrecognized verification response stops the migration with the backup intact', async (t) => {
  const stub = await startQdrantStub();
  t.after(() => stub.close());
  seedDocs(stub);
  stub.failOn = ({ method, path }) =>
    method === 'POST' &&
    path === `${backupPath}/points` && {
      status: 200,
      body: { result: { points: [] } },
    };
  await assert.rejects(
    migrateQdrantMultivectors({ url: stub.baseUrl, collection }),
    {
      code: RAG_MIGRATION_UNCONFIRMED,
      message:
        /Could not confirm POST .*Unexpected Qdrant response.*docs.*rerun/,
    },
  );
  assert.equal(stub.requests.at(-1)?.path, `${backupPath}/points`);
  assert.deepEqual(stub.collections.get(collection)?.points.get(id), point);
  assert.deepEqual(
    stub.collections.get(temporaryCollection)?.points.get(id),
    converted,
  );
});

test('CLI --collections accepts comma-separated and repeated names and --dry-run reports recovery', async (t) => {
  const stub = await startQdrantStub();
  t.after(() => stub.close());
  await interruptBeforeRestore(stub);
  for (const name of ['first', 'last'])
    stub.collections.set(name, { size: 2, points: new Map() });

  const argv = process.argv;
  const exitCode = process.exitCode;
  const log = t.mock.method(console, 'log', (_message: string) => {});
  const error = t.mock.method(console, 'error', (_message: string) => {});
  async function runCli(invocation: string, args: string[]) {
    process.argv = [...argv.slice(0, 2), '--url', stub.baseUrl, ...args];
    const entry = new URL('../migrate-multivector-cli.js', import.meta.url);
    entry.searchParams.set('invocation', invocation);
    await import(entry.href);
  }

  try {
    const args = ['--collections', 'first, optional', '--collections', 'last'];
    await runCli('plan', [...args, '--dry-run']);
    assert.equal(error.mock.calls.length, 0);
    const expected = [
      [collection, 'resume'],
      ['first', 'migrate'],
      ['optional', 'absent'],
      ['last', 'migrate'],
    ];
    const reports = () =>
      log.mock.calls.map(({ arguments: [line] }) => {
        const { collection, action } = JSON.parse(String(line)) as {
          collection: string;
          action: string;
        };
        return [collection, action];
      });
    assert.deepEqual(reports(), expected);
    assert.ok(stub.requests.every(({ method }) => method === 'GET'));
    log.mock.resetCalls();
    await runCli('migration', args);
    assert.equal(error.mock.calls.length, 0);
    assert.deepEqual(reports(), expected);
    assert.equal(stub.collections.has(temporaryCollection), false);
    assert.equal(stub.collections.get('last')?.multivector, true);

    log.mock.resetCalls();
    await runCli('recovery-only', ['--collections=']);
    assert.equal(error.mock.calls.length, 0);
    assert.deepEqual(log.mock.calls, []);
    await runCli('conflicting-flags', ['--collections=first', '--all']);
    assert.equal(process.exitCode, 1);
    assert.match(String(error.mock.calls[0]?.arguments[0]), /Usage:/);
  } finally {
    process.argv = argv;
    process.exitCode = exitCode;
  }
});
