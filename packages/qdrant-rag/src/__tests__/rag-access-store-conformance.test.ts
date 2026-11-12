import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { checkRagAccess, symmetricEmbedder } from '@mcp-abap-adt/llm-agent';
import { ragAccessStoreConformanceCases } from '@mcp-abap-adt/llm-agent/testing/rag-access-store-conformance';
import { conformanceEmbedder } from '@mcp-abap-adt/llm-agent/testing/rag-filter-conformance';
import { createQdrantVectorRagAccessStores } from '../access-stores.js';
import { migrateQdrantVectorRagAccess } from '../migrate-access.js';
import { QdrantRagProvider } from '../qdrant-rag-provider.js';
import { startQdrantStub } from './qdrant-stub.js';

for (const item of ragAccessStoreConformanceCases) {
  test(`Qdrant ${item.name}`, async () => {
    const stub = await startQdrantStub();
    try {
      const provider = new QdrantRagProvider({
        name: 'test',
        url: stub.baseUrl,
        embedder: symmetricEmbedder({
          embed: async () => ({ vector: [1, 0, 0] }),
        }),
      });
      assert.ok((await migrateQdrantVectorRagAccess(provider)).ok);
      await item.run(async () => ({
        ...createQdrantVectorRagAccessStores(provider),
        independentStores: async () =>
          createQdrantVectorRagAccessStores(
            new QdrantRagProvider({
              name: 'other',
              url: stub.baseUrl,
              embedder: symmetricEmbedder({
                embed: async () => ({ vector: [1, 0, 0] }),
              }),
            }),
          ),
        deleteCollection: (name: string) => provider.deleteCollection(name),
        async createCollection(name: string) {
          const result = await provider.createCollection(name, {
            scope: 'user',
            userId: 'owner',
            dimension: 3,
          });
          return result.ok ? { ok: true as const, value: undefined } : result;
        },
      }));
    } finally {
      await stub.close();
    }
  });
}

test('Qdrant two binding-store instances give exactly one ok and preserve the winner', async () => {
  const stub = await startQdrantStub();
  try {
    const config = {
      name: 'bindings',
      url: stub.baseUrl,
      embedder: symmetricEmbedder(conformanceEmbedder()),
    };
    const a = createQdrantVectorRagAccessStores(new QdrantRagProvider(config));
    const b = createQdrantVectorRagAccessStores(new QdrantRagProvider(config));
    const results = await Promise.all([
      a.bindings.bind('s', 'u1'),
      b.bindings.bind('s', 'u2'),
    ]);
    assert.equal(results.filter((result) => result.ok).length, 1);
    const winner = results[0].ok ? 'u1' : 'u2';
    assert.ok(
      (
        await createQdrantVectorRagAccessStores(
          new QdrantRagProvider(config),
        ).bindings.bind('s', winner)
      ).ok,
    );
  } finally {
    await stub.close();
  }
});

test('Qdrant tombstoned role grants no membership, refuses creation and deleteRole rerun completes', async () => {
  const stub = await startQdrantStub();
  try {
    const provider = new QdrantRagProvider({
      name: 'crash',
      url: stub.baseUrl,
      embedder: symmetricEmbedder(conformanceEmbedder()),
    });
    const stores = createQdrantVectorRagAccessStores(provider);
    assert.ok(
      (await stores.roleAdmin.createRole({ roleId: 'r', name: 'Role' })).ok,
    );
    assert.ok((await stores.roleAdmin.assign('u', 'r')).ok);
    const db = await provider.accessPersistence();
    const current = await db.roleState('r');
    assert.ok(current);
    assert.ok(await db.transitionRole(current, 'deleting'));
    const membership = await stores.roles.rolesOf('u');
    assert.ok(membership.ok);
    assert.equal(membership.value.has('r'), false);
    assert.equal(
      (await stores.roleAdmin.createRole({ roleId: 'r', name: 'Replacement' }))
        .ok,
      false,
    );
    assert.ok((await stores.roleAdmin.revoke('u', 'r')).ok);
    assert.ok((await stores.roleAdmin.deleteRole('r')).ok);
    assert.equal((await db.roleState('r'))?.state, 'deleted');
    assert.equal(stub.collections.has('rag_role_locks'), false);
  } finally {
    await stub.close();
  }
});

test('Qdrant rejects servers without insert_only before writing access data', async () => {
  const stub = await startQdrantStub();
  try {
    stub.version = '1.16.0';
    const provider = new QdrantRagProvider({
      name: 'old',
      url: stub.baseUrl,
      embedder: symmetricEmbedder(conformanceEmbedder()),
    });
    assert.equal(
      (
        await createQdrantVectorRagAccessStores(provider).bindings.bind(
          's',
          'u',
        )
      ).ok,
      false,
    );
    assert.equal(stub.collections.size, 0);
  } finally {
    await stub.close();
  }
});

test('Qdrant refuses insufficient replica write consistency and never writes a binding', async () => {
  const stub = await startQdrantStub();
  try {
    stub.collections.set('rag_collection_catalog', {
      size: 1,
      points: new Map(),
      replicationFactor: 2,
      writeConsistencyFactor: 1,
    });
    const provider = new QdrantRagProvider({
      name: 'replicas',
      url: stub.baseUrl,
      embedder: symmetricEmbedder(conformanceEmbedder()),
    });
    assert.equal(
      (
        await createQdrantVectorRagAccessStores(provider).bindings.bind(
          's',
          'u',
        )
      ).ok,
      false,
    );
    assert.equal(
      stub.requests.some(
        (request) =>
          request.path.endsWith('/points') && request.method === 'PUT',
      ),
      false,
    );
  } finally {
    await stub.close();
  }
});

test('Qdrant custom catalogs isolate access stores and reserve their internal collection names', async () => {
  const stub = await startQdrantStub();
  try {
    const config = {
      name: 'domains',
      url: stub.baseUrl,
      embedder: symmetricEmbedder(conformanceEmbedder()),
    };
    const a = new QdrantRagProvider({
      ...config,
      catalogCollection: 'catalog_a',
    });
    const b = new QdrantRagProvider({
      ...config,
      catalogCollection: 'catalog_b',
    });
    const first = createQdrantVectorRagAccessStores(a);
    const second = createQdrantVectorRagAccessStores(b);
    assert.ok((await first.bindings.bind('s', 'u1')).ok);
    assert.ok((await second.bindings.bind('s', 'u2')).ok);
    assert.ok(
      (await first.roleAdmin.createRole({ roleId: 'r', name: 'First' })).ok,
    );
    assert.ok((await first.roleAdmin.assign('u1', 'r')).ok);
    const other = await second.roles.rolesOf('u1');
    assert.ok(other.ok);
    assert.equal(other.value.size, 0);
    for (const name of [
      'rag_roles',
      'rag_collection_roles',
      'rag_role_assignments',
      'rag_session_bindings',
    ]) {
      assert.equal(
        (
          await a.createCollection(`catalog_a_${name}`, {
            scope: 'global',
            dimension: 64,
          })
        ).ok,
        false,
      );
      assert.equal((await a.deleteCollection(`catalog_a_${name}`)).ok, false);
      assert.equal(
        (
          await a.openCollection({
            storeName: `catalog_a_${name}`,
            name: 'Internal',
            scope: 'global',
          })
        ).ok,
        false,
      );
      assert.equal(
        (
          await b.createCollection(`catalog_a_${name}`, {
            scope: 'global',
            dimension: 64,
            adoptExisting: true,
          })
        ).ok,
        false,
      );
      const listed = await a.listCollections();
      assert.ok(listed.ok);
      assert.equal(listed.value.includes(`catalog_a_${name}`), false);
      assert.equal(listed.value.includes(`catalog_b_${name}`), false);
    }
  } finally {
    await stub.close();
  }
});

test('Qdrant binding reads fail closed on backend failures', async () => {
  const stub = await startQdrantStub();
  try {
    const provider = new QdrantRagProvider({
      name: 'failed-read',
      url: stub.baseUrl,
      embedder: symmetricEmbedder(conformanceEmbedder()),
    });
    await provider.accessPersistence();
    stub.failOn = (request) =>
      request.path === '/collections/rag_session_bindings/points' &&
      request.method === 'POST';
    assert.equal(
      (
        await createQdrantVectorRagAccessStores(provider).bindings.bind(
          's',
          'u',
        )
      ).ok,
      false,
    );
    stub.failOn = undefined;
    assert.equal(
      (
        await createQdrantVectorRagAccessStores(provider).bindings.bind(
          's',
          'other',
        )
      ).ok,
      false,
    );
    assert.ok(
      (
        await createQdrantVectorRagAccessStores(provider).bindings.bind(
          's',
          'u',
        )
      ).ok,
    );
  } finally {
    await stub.close();
  }
});

function controlledBarrier() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test('Qdrant a delayed assignment cannot attach to a recreated role identity', async () => {
  const stub = await startQdrantStub();
  const entered = controlledBarrier();
  const resume = controlledBarrier();
  let intercept: ReturnType<typeof mock.method> | undefined;
  try {
    const provider = new QdrantRagProvider({
      name: 'generation',
      url: stub.baseUrl,
      embedder: symmetricEmbedder(conformanceEmbedder()),
    });
    const roles = createQdrantVectorRagAccessStores(provider).roleAdmin;
    assert.ok((await roles.createRole({ roleId: 'r', name: 'Old' })).ok);
    const fetch = globalThis.fetch;
    let paused = false;
    intercept = mock.method(
      globalThis,
      'fetch',
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        if (
          !paused &&
          new URL(String(input)).pathname ===
            '/collections/rag_role_assignments/points' &&
          init?.method === 'PUT'
        ) {
          paused = true;
          entered.release();
          await resume.promise;
        }
        return fetch(input, init);
      },
    );
    const assigning = roles.assign('u', 'r');
    await entered.promise;
    assert.ok((await roles.deleteRole('r')).ok);
    assert.ok((await roles.createRole({ roleId: 'r', name: 'New' })).ok);
    resume.release();
    assert.equal((await assigning).ok, false);
    const membership =
      await createQdrantVectorRagAccessStores(provider).roles.rolesOf('u');
    assert.ok(membership.ok);
    assert.equal(membership.value.has('r'), false);
  } finally {
    resume.release();
    intercept?.mock.restore();
    await stub.close();
  }
});

for (const pause of ['before-insert', 'after-insert'] as const) {
  for (const recreate of [false, true]) {
    test(`Qdrant collection deletion fences delayed binding: ${pause}, recreate=${recreate}`, async () => {
      const stub = await startQdrantStub();
      const entered = controlledBarrier();
      const resume = controlledBarrier();
      let intercept: ReturnType<typeof mock.method> | undefined;
      try {
        const config = {
          name: 'race',
          url: stub.baseUrl,
          embedder: symmetricEmbedder(conformanceEmbedder()),
        };
        const provider = new QdrantRagProvider(config);
        const other = new QdrantRagProvider(config);
        const first = createQdrantVectorRagAccessStores(provider);
        const second = createQdrantVectorRagAccessStores(other);
        assert.ok(
          (
            await provider.createCollection('docs', {
              scope: 'user',
              userId: 'owner',
              dimension: 64,
            })
          ).ok,
        );
        assert.ok(
          (await first.roleAdmin.createRole({ roleId: 'r', name: 'Reader' }))
            .ok,
        );
        const db = await other.accessPersistence();
        const insert = db.insert.bind(db);
        intercept = mock.method(
          db,
          'insert',
          async (...args: Parameters<typeof insert>) => {
            if (args[0] === 'rag_collection_roles' && args[2].role_id === 'r') {
              if (pause === 'after-insert') await insert(...args);
              entered.release();
              await resume.promise;
              if (pause === 'before-insert') await insert(...args);
              return;
            }
            return insert(...args);
          },
        );
        const binding = second.roleAdmin.bindCollection('docs', 'r');
        await entered.promise;
        assert.ok((await provider.deleteCollection('docs')).ok);
        if (recreate)
          assert.ok(
            (
              await provider.createCollection('docs', {
                scope: 'user',
                userId: 'owner',
                dimension: 64,
              })
            ).ok,
          );
        resume.release();
        assert.equal((await binding).ok, false);
        assert.deepEqual(await first.roles.collectionRoles('docs'), {
          ok: true,
          value: new Set(),
        });
        assert.equal(
          (await db.rows('rag_collection_roles')).some(
            (row) => row.collection_name === 'docs',
          ),
          false,
        );
        assert.ok((await first.roleAdmin.deleteRole('r')).ok);
      } finally {
        resume.release();
        intercept?.mock.restore();
        await stub.close();
      }
    });
  }
}

test('Qdrant collectionRoles ignores a stale catalog generation even with an active role', async () => {
  const stub = await startQdrantStub();
  try {
    const provider = new QdrantRagProvider({
      name: 'generation',
      url: stub.baseUrl,
      embedder: symmetricEmbedder(conformanceEmbedder()),
    });
    const stores = createQdrantVectorRagAccessStores(provider);
    assert.ok(
      (
        await provider.createCollection('docs', {
          scope: 'user',
          userId: 'owner',
          dimension: 64,
        })
      ).ok,
    );
    assert.ok(
      (await stores.roleAdmin.createRole({ roleId: 'r', name: 'Reader' })).ok,
    );
    const db = await provider.accessPersistence();
    const role = await db.requireRole('r');
    await db.insert('rag_collection_roles', JSON.stringify(['docs', 'r']), {
      collection_name: 'docs',
      role_id: 'r',
      role_token: role.token,
      catalog_write_id: 'old-generation',
    });
    assert.deepEqual(await stores.roles.collectionRoles('docs'), {
      ok: true,
      value: new Set(),
    });
    await db.remove(db.catalog, 'docs');
    assert.deepEqual(await stores.roles.collectionRoles('docs'), {
      ok: true,
      value: new Set(),
    });
  } finally {
    await stub.close();
  }
});

test('Qdrant collectionRoles fails closed for corrupt bindings and malformed deletion markers', async () => {
  const stub = await startQdrantStub();
  try {
    const provider = new QdrantRagProvider({
      name: 'corrupt-bindings',
      url: stub.baseUrl,
      embedder: symmetricEmbedder(conformanceEmbedder()),
    });
    const stores = createQdrantVectorRagAccessStores(provider);
    const db = await provider.accessPersistence();
    const intent = JSON.stringify(['deleting', 'docs', 'generation']);
    const malformed = [
      { collection_name: 'docs' },
      { collection_name: 'docs', deletion_intent: intent },
      {
        collection_name: 'docs',
        store_name: 'docs',
        write_id: 'generation',
        deletion_intent: 'invalid',
      },
      {
        collection_name: 'docs',
        store_name: 'docs',
        write_id: 'generation',
        deletion_intent: intent,
        role_token: 'incomplete-binding',
      },
    ];
    for (const payload of malformed) {
      await db.insert('rag_collection_roles', 'corrupt', payload);
      const result = await stores.roles.collectionRoles('docs');
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, 'RAG_ACCESS_STORE_ERROR');
      await db.remove('rag_collection_roles', 'corrupt');
    }
  } finally {
    await stub.close();
  }
});

test('Qdrant a durable collection deletion intent denies role access and concurrent binding before catalog removal', async () => {
  const stub = await startQdrantStub();
  const entered = controlledBarrier();
  const resume = controlledBarrier();
  let intercept: ReturnType<typeof mock.method> | undefined;
  try {
    const config = {
      name: 'intent',
      url: stub.baseUrl,
      embedder: symmetricEmbedder(conformanceEmbedder()),
    };
    const provider = new QdrantRagProvider(config);
    const first = createQdrantVectorRagAccessStores(provider);
    const second = createQdrantVectorRagAccessStores(
      new QdrantRagProvider(config),
    );
    assert.ok(
      (
        await provider.createCollection('docs', {
          scope: 'user',
          userId: 'owner',
          dimension: 64,
        })
      ).ok,
    );
    assert.ok(
      (await first.roleAdmin.createRole({ roleId: 'r', name: 'Reader' })).ok,
    );
    assert.ok((await first.roleAdmin.bindCollection('docs', 'r')).ok);
    const db = await provider.accessPersistence();
    const remove = db.removeWhere.bind(db);
    intercept = mock.method(
      db,
      'removeWhere',
      async (...args: Parameters<typeof remove>) => {
        if (args[0] === db.catalog && args[1].write_id) {
          entered.release();
          await resume.promise;
        }
        return remove(...args);
      },
    );
    const deleting = provider.deleteCollection('docs');
    await entered.promise;
    assert.deepEqual(await second.roles.collectionRoles('docs'), {
      ok: true,
      value: new Set(),
    });
    assert.equal(
      (await second.roleAdmin.bindCollection('docs', 'r')).ok,
      false,
    );
    resume.release();
    assert.ok((await deleting).ok);
    assert.ok((await first.roleAdmin.deleteRole('r')).ok);
  } finally {
    resume.release();
    intercept?.mock.restore();
    await stub.close();
  }
});

test('Qdrant a failed catalog deletion preserves data and bindings and can be retried', async () => {
  const stub = await startQdrantStub();
  try {
    const provider = new QdrantRagProvider({
      name: 'retry',
      url: stub.baseUrl,
      embedder: symmetricEmbedder(conformanceEmbedder()),
    });
    const stores = createQdrantVectorRagAccessStores(provider);
    assert.ok(
      (
        await provider.createCollection('docs', {
          scope: 'user',
          userId: 'owner',
          dimension: 64,
        })
      ).ok,
    );
    assert.ok(
      (await stores.roleAdmin.createRole({ roleId: 'r', name: 'Reader' })).ok,
    );
    assert.ok((await stores.roleAdmin.bindCollection('docs', 'r')).ok);
    assert.ok((await stores.roleAdmin.assign('reader', 'r')).ok);
    const data = stub.collections.get('docs');
    assert.ok(data);
    const point = { id: 'document', vector: [1], payload: { text: 'Keep me' } };
    data.points.set(point.id, point);
    const db = await provider.accessPersistence();
    const originalBindings = await db.rows('rag_collection_roles');
    stub.failOn = (request) =>
      request.path === '/collections/rag_collection_catalog/points/delete';
    const result = await provider.deleteCollection('docs');
    assert.equal(result.ok, false);
    if (!result.ok)
      assert.equal(result.error.code, 'RAG_CATALOG_RECORD_DELETE');
    assert.equal(stub.collections.has('docs'), true);
    assert.deepEqual([...data.points.values()], [point]);
    assert.ok(await db.read(db.catalog, 'docs'));
    const bindings = await db.rows('rag_collection_roles');
    assert.deepEqual(bindings, originalBindings);
    assert.equal(bindings.length, 1);
    assert.equal(bindings[0]?.role_id, 'r');
    assert.equal(
      bindings.some((row) => row.deletion_intent),
      false,
    );
    assert.deepEqual(await stores.roles.rolesOf('reader'), {
      ok: true,
      value: new Set(['r']),
    });
    assert.deepEqual(await stores.roles.collectionRoles('docs'), {
      ok: true,
      value: new Set(['r']),
    });
    stub.failOn = undefined;
    assert.ok((await provider.deleteCollection('docs')).ok);
    assert.ok((await stores.roleAdmin.revoke('reader', 'r')).ok);
    assert.ok((await stores.roleAdmin.deleteRole('r')).ok);
  } finally {
    await stub.close();
  }
});

for (const crashStage of ['catalog', 'data', 'bindings'] as const) {
  test(`Qdrant deletion resumes after ${crashStage} removal via a new provider`, async () => {
    const stub = await startQdrantStub();
    const intercepts: ReturnType<typeof mock.method>[] = [];
    try {
      const config = {
        name: 'crash-retry',
        url: stub.baseUrl,
        embedder: symmetricEmbedder(conformanceEmbedder()),
      };
      const original = new QdrantRagProvider(config);
      const stores = createQdrantVectorRagAccessStores(original);
      assert.ok(
        (
          await original.createCollection('docs', {
            scope: 'user',
            userId: 'owner',
            dimension: 64,
          })
        ).ok,
      );
      assert.ok(
        (await stores.roleAdmin.createRole({ roleId: 'r', name: 'Reader' })).ok,
      );
      assert.ok((await stores.roleAdmin.assign('reader', 'r')).ok);
      assert.ok((await stores.roleAdmin.bindCollection('docs', 'r')).ok);
      const db = await original.accessPersistence();
      const catalog = await db.read(db.catalog, 'docs');
      const role = await db.requireRole('r');
      assert.equal(typeof catalog?.write_id, 'string');
      const remove = db.removeWhere.bind(db);
      intercepts.push(
        mock.method(
          db,
          'removeWhere',
          async (...args: Parameters<typeof remove>) => {
            await remove(...args);
            if (
              (crashStage === 'catalog' && args[0] === db.catalog) ||
              (crashStage === 'bindings' && args[0] === 'rag_collection_roles')
            ) {
              throw new Error('Simulated process crash');
            }
          },
        ),
      );
      if (crashStage === 'data') {
        const fetch = globalThis.fetch;
        intercepts.push(
          mock.method(
            globalThis,
            'fetch',
            async (...args: Parameters<typeof fetch>) => {
              const response = await fetch(...args);
              if (
                String(args[0]) === `${stub.baseUrl}/collections/docs` &&
                args[1]?.method === 'DELETE'
              ) {
                throw new Error('Simulated process crash');
              }
              return response;
            },
          ),
        );
      }
      assert.equal((await original.deleteCollection('docs')).ok, false);
      if (crashStage === 'catalog') {
        assert.equal(await db.read(db.catalog, 'docs'), undefined);
        assert.ok(
          (await db.rows('rag_collection_roles')).some(
            (row) => row.deletion_intent,
          ),
        );
        assert.deepEqual(await stores.roles.collectionRoles('docs'), {
          ok: true,
          value: new Set(),
        });
      }
      for (const intercept of intercepts) intercept.mock.restore();
      const retry = new QdrantRagProvider(config);
      assert.ok((await retry.deleteCollection('docs')).ok);
      assert.equal(stub.collections.has('docs'), false);
      assert.equal(await db.read(db.catalog, 'docs'), undefined);
      assert.deepEqual(await db.rows('rag_collection_roles'), []);
      assert.deepEqual(await stores.roles.collectionRoles('docs'), {
        ok: true,
        value: new Set(),
      });
      assert.ok((await retry.deleteCollection('docs')).ok);
      assert.ok(
        (
          await retry.createCollection('docs', {
            scope: 'user',
            userId: 'owner',
            dimension: 64,
          })
        ).ok,
      );
      const readers = createQdrantVectorRagAccessStores(retry);
      // Even a delayed old-generation binding cannot grant access after recreation.
      await db.insert('rag_collection_roles', JSON.stringify(['docs', 'r']), {
        collection_name: 'docs',
        role_id: 'r',
        role_token: role.token,
        catalog_write_id: catalog?.write_id,
      });
      assert.ok((await readers.bindings.bind('reader-session', 'reader')).ok);
      const denied = await checkRagAccess(
        { sessionId: 'reader-session', userId: 'reader', isAdmin: false },
        { name: 'docs', owner: { scope: 'user', userId: 'owner' } },
        'read',
        {
          ...readers,
          decision: { canRead: async () => true, canWrite: async () => true },
        },
      );
      assert.equal(!denied.ok && denied.error.code, 'RAG_ACCESS_DENIED');

      assert.deepEqual(await readers.roles.rolesOf('reader'), {
        ok: true,
        value: new Set(['r']),
      });
      assert.deepEqual(await readers.roles.collectionRoles('docs'), {
        ok: true,
        value: new Set(),
      });
    } finally {
      for (const intercept of intercepts) intercept.mock.restore();
      await stub.close();
    }
  });
}
