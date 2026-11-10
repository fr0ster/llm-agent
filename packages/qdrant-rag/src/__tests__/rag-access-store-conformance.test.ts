import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { symmetricEmbedder } from '@mcp-abap-adt/llm-agent';
import {
  type RagAccessBarrierHook,
  ragAccessStoreConformanceCases,
} from '@mcp-abap-adt/llm-agent/testing/rag-access-store-conformance';
import { conformanceEmbedder } from '@mcp-abap-adt/llm-agent/testing/rag-filter-conformance';
import { createQdrantRagAccessStores } from '../access-stores.js';
import { migrateQdrantRagAccess } from '../migrate-access.js';
import { QdrantRagProvider } from '../qdrant-rag-provider.js';
import { startQdrantStub } from './qdrant-stub.js';

for (const entry of ragAccessStoreConformanceCases) {
  test(`Qdrant ${entry.name}`, async () => {
    const stub = await startQdrantStub();
    try {
      await entry.run(async () => {
        let hook: RagAccessBarrierHook = async () => {};
        const config = {
          name: 'access',
          url: stub.baseUrl,
          embedder: symmetricEmbedder(conformanceEmbedder()),
        };
        const provider = new QdrantRagProvider(config);
        const other = new QdrantRagProvider(config);
        assert.ok((await migrateQdrantRagAccess(provider)).ok);
        const persistence = await provider.accessPersistence();
        const otherPersistence = await other.accessPersistence();
        const stores = createQdrantRagAccessStores(provider);
        const roles = {
          ...stores.roles,
          async createRole(
            role: Parameters<typeof stores.roles.createRole>[0],
          ) {
            const result = await stores.roles.createRole(role);
            if (result.ok && role.roleId === 'in-use') {
              assert.ok(
                (
                  await provider.createCollection('used', {
                    scope: 'role',
                    roleId: role.roleId,
                    dimension: 64,
                  })
                ).ok,
              );
            }
            return result;
          },
          async deleteRole(roleId: string) {
            await hook('deletion');
            return stores.roles.deleteRole(roleId);
          },
        };
        return {
          roles,
          deletionSerializesCreation: false,
          setDeletionRaceHooks(hooks) {
            {
              const db = persistence;
              const rows = db.rows.bind(db);
              let first = true;
              db.rows = async (collection) => {
                if (collection === 'rag_role_assignments' && first) {
                  first = false;
                  await hooks.deletionPaused();
                }
                return rows(collection);
              };
            }
            {
              const db = otherPersistence;
              const requireRole = db.requireRole.bind(db);
              db.requireRole = async (roleId) => {
                await hooks.creationPaused();
                return requireRole(roleId);
              };
            }
          },
          async rawCatalogRoleIds() {
            const db = await provider.accessPersistence();
            return (await db.rows(db.catalog))
              .filter((row) => row.scope === 'role')
              .map((row) => String(row.role_id));
          },
          async rawAssignmentRoleIds() {
            const db = await provider.accessPersistence();
            return (await db.rows('rag_role_assignments')).map((row) =>
              String(row.role_id),
            );
          },
          bindings: {
            getUserId: (sessionId) =>
              createQdrantRagAccessStores(other).bindings.getUserId(sessionId),
            bind: (sessionId, userId) =>
              createQdrantRagAccessStores(other).bindings.bind(
                sessionId,
                userId,
              ),
          },
          setBarrierHook(next) {
            hook = next;
          },
          async createRoleCollection(roleId) {
            await hook('creation');
            const result = await other.createCollection(`docs_${roleId}`, {
              scope: 'role',
              roleId,
              dimension: 64,
            });
            return result.ok ? { ok: true, value: undefined } : result;
          },
          async collections() {
            const result = await provider.describeCollections();
            assert.ok(result.ok);
            return result.value.records;
          },
        };
      });
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
    const a = createQdrantRagAccessStores(new QdrantRagProvider(config));
    const b = createQdrantRagAccessStores(new QdrantRagProvider(config));
    const results = await Promise.all([
      a.bindings.bind('s', 'u1'),
      b.bindings.bind('s', 'u2'),
    ]);
    assert.equal(results.filter((result) => result.ok).length, 1);
    const winner = results[0].ok ? 'u1' : 'u2';
    assert.ok(
      (
        await createQdrantRagAccessStores(
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
    const stores = createQdrantRagAccessStores(provider);
    assert.ok(
      (await stores.roles.createRole({ roleId: 'r', name: 'Role' })).ok,
    );
    assert.ok((await stores.roles.assign('u', 'r')).ok);
    const db = await provider.accessPersistence();
    const current = await db.roleState('r');
    assert.ok(current);
    assert.ok(await db.transitionRole(current, 'deleting'));
    const membership = await stores.roles.rolesOf('u');
    assert.ok(membership.ok);
    assert.equal(membership.value.has('r'), false);
    assert.equal(
      (
        await provider.createCollection('crashed', {
          scope: 'role',
          roleId: 'r',
          dimension: 64,
        })
      ).ok,
      false,
    );
    assert.ok((await stores.roles.deleteRole('r')).ok);
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
      (await createQdrantRagAccessStores(provider).bindings.bind('s', 'u')).ok,
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
      (await createQdrantRagAccessStores(provider).bindings.bind('s', 'u')).ok,
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
    const first = createQdrantRagAccessStores(a);
    const second = createQdrantRagAccessStores(b);
    assert.ok((await first.bindings.bind('s', 'u1')).ok);
    assert.ok((await second.bindings.bind('s', 'u2')).ok);
    assert.ok(
      (await first.roles.createRole({ roleId: 'r', name: 'First' })).ok,
    );
    assert.ok((await first.roles.assign('u1', 'r')).ok);
    const other = await second.roles.rolesOf('u1');
    assert.ok(other.ok);
    assert.equal(other.value.size, 0);
    for (const name of [
      'rag_roles',
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
      (await createQdrantRagAccessStores(provider).bindings.bind('s', 'u')).ok,
      false,
    );
    stub.failOn = undefined;
    assert.equal(
      (await createQdrantRagAccessStores(provider).bindings.bind('s', 'other'))
        .ok,
      false,
    );
    assert.ok(
      (await createQdrantRagAccessStores(provider).bindings.bind('s', 'u')).ok,
    );
  } finally {
    await stub.close();
  }
});

test('Qdrant a catalog intent left after a crash with a missing role never resolves and migration reports it', async () => {
  const stub = await startQdrantStub();
  try {
    const provider = new QdrantRagProvider({
      name: 'intent',
      url: stub.baseUrl,
      embedder: symmetricEmbedder(conformanceEmbedder()),
    });
    const db = await provider.accessPersistence();
    // Step-wise crash fixture: catalog intent persisted, role deleted before verification.
    await db.insert('rag_collection_catalog', 'orphan', {
      store_name: 'orphan',
      collection_name: 'Orphan',
      scope: 'role',
      role_id: 'gone',
    });
    stub.collections.set('orphan', { size: 64, points: new Map() });
    assert.equal(
      (
        await provider.openCollection({
          storeName: 'orphan',
          name: 'Orphan',
          scope: 'role',
          roleId: 'gone',
        })
      ).ok,
      false,
    );
    const description = await provider.describeCollections();
    assert.ok(description.ok);
    assert.equal(description.value.records.length, 0);
    const migration = await migrateQdrantRagAccess(provider);
    assert.ok(migration.ok);
    assert.ok(
      migration.value.reported.some((row) => row.storeName === 'orphan'),
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

for (const first of ['creation', 'deletion'] as const) {
  test(`Qdrant ${first} intent is durable before the competing instance verifies`, async () => {
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
      const a = new QdrantRagProvider(config);
      const b = new QdrantRagProvider(config);
      const roles = createQdrantRagAccessStores(a).roles;
      assert.ok((await roles.createRole({ roleId: 'r', name: 'Role' })).ok);
      await b.accessPersistence();
      const fetch = globalThis.fetch;
      let paused = false;
      intercept = mock.method(
        globalThis,
        'fetch',
        async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const path = new URL(String(input)).pathname;
          const response = await fetch(input, init);
          if (
            !paused &&
            ((first === 'creation' &&
              path === '/collections/rag_collection_catalog/points' &&
              init?.method === 'PUT') ||
              (first === 'deletion' &&
                path === '/collections/rag_roles/points' &&
                init?.method === 'PUT'))
          ) {
            paused = true;
            entered.release();
            await resume.promise;
          }
          return response;
        },
      );
      const create = () =>
        b.createCollection('race_docs', {
          scope: 'role',
          roleId: 'r',
          dimension: 64,
        });
      const remove = () => roles.deleteRole('r');
      const started = first === 'creation' ? create() : remove();
      await entered.promise;
      assert.equal(
        (await (first === 'creation' ? remove() : create())).ok,
        false,
      );
      resume.release();
      assert.ok((await started).ok);
      const catalog = await a.describeCollections();
      assert.ok(catalog.ok);
      assert.equal(catalog.value.records.length, first === 'creation' ? 1 : 0);
      assert.equal(stub.collections.has('rag_role_locks'), false);
    } finally {
      resume.release();
      intercept?.mock.restore();
      await stub.close();
    }
  });
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
    const roles = createQdrantRagAccessStores(provider).roles;
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
    const membership = await roles.rolesOf('u');
    assert.ok(membership.ok);
    assert.equal(membership.value.has('r'), false);
  } finally {
    resume.release();
    intercept?.mock.restore();
    await stub.close();
  }
});

test('Qdrant refused creation compensates only its own catalog write intent', async () => {
  const stub = await startQdrantStub();
  let intercept: ReturnType<typeof mock.method> | undefined;
  try {
    const provider = new QdrantRagProvider({
      name: 'compensation',
      url: stub.baseUrl,
      embedder: symmetricEmbedder(conformanceEmbedder()),
    });
    await provider.accessPersistence();
    const fetch = globalThis.fetch;
    let replaced = false;
    intercept = mock.method(
      globalThis,
      'fetch',
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        if (
          !replaced &&
          new URL(String(input)).pathname ===
            '/collections/rag_collection_catalog/points/delete'
        ) {
          const collection = stub.collections.get('rag_collection_catalog');
          assert.ok(collection);
          const point = [...collection.points.values()].find(
            (point) => point.payload.store_name === 'docs',
          );
          assert.ok(point);
          point.payload = {
            store_name: 'docs',
            collection_name: 'Replacement',
            scope: 'global',
            write_id: 'replacement',
          };
          replaced = true;
        }
        return fetch(input, init);
      },
    );
    assert.equal(
      (
        await provider.createCollection('docs', {
          scope: 'role',
          roleId: 'missing',
          dimension: 64,
        })
      ).ok,
      false,
    );
    assert.equal(replaced, true);
    const description = await provider.describeCollections();
    assert.ok(description.ok);
    assert.equal(description.value.records[0]?.name, 'Replacement');
  } finally {
    intercept?.mock.restore();
    await stub.close();
  }
});

for (const pause of ['scan', 'assignment-delete'] as const)
  test(`Qdrant D1/C/D2 cannot strand a catalog intent without an active role: ${pause}`, async () => {
    const stub = await startQdrantStub();
    const d1Entered = controlledBarrier();
    const d1Resume = controlledBarrier();
    const cEntered = controlledBarrier();
    const cResume = controlledBarrier();
    try {
      const config = {
        name: 'fence',
        url: stub.baseUrl,
        embedder: symmetricEmbedder(conformanceEmbedder()),
      };
      const a = new QdrantRagProvider(config);
      const b = new QdrantRagProvider(config);
      const roles = createQdrantRagAccessStores(a).roles;
      assert.ok((await roles.createRole({ roleId: 'r', name: 'Role' })).ok);
      assert.ok((await roles.assign('u', 'r')).ok);
      const db = await a.accessPersistence();
      const other = await b.accessPersistence();
      const rows = db.rows.bind(db);
      let paused = false;
      const intercept = mock.method(db, 'rows', async (collection: string) => {
        if (
          pause === 'scan' &&
          collection === 'rag_role_assignments' &&
          !paused
        ) {
          paused = true;
          d1Entered.release();
          await d1Resume.promise;
        }
        return rows(collection);
      });
      const remove = db.remove.bind(db);
      const removalGate = mock.method(
        db,
        'remove',
        async (collection: string, key: string) => {
          if (
            pause === 'assignment-delete' &&
            collection === 'rag_role_assignments' &&
            !paused
          ) {
            paused = true;
            d1Entered.release();
            await d1Resume.promise;
          }
          return remove(collection, key);
        },
      );
      const requireRole = other.requireRole.bind(other);
      const creationGate = mock.method(
        other,
        'requireRole',
        async (roleId: string) => {
          cEntered.release();
          await cResume.promise;
          return requireRole(roleId);
        },
      );
      const d1 = roles.deleteRole('r');
      await d1Entered.promise;
      const c = b.createCollection('docs', {
        scope: 'role',
        roleId: 'r',
        dimension: 64,
      });
      await cEntered.promise;
      assert.equal((await roles.deleteRole('r')).ok, false);
      cResume.release();
      const created = await c;
      d1Resume.release();
      await d1;
      const catalog = await db.rows(db.catalog);
      const active = await roles.listRoles();
      assert.ok(active.ok);
      for (const row of catalog)
        if (row.scope === 'role')
          assert.ok(
            active.value.some((role) => role.roleId === row.role_id),
            'raw catalog requires active role',
          );
      const assignments = await roles.rolesOf('u');
      assert.ok(assignments.ok);
      assert.ok(created.ok);
      assert.equal((await db.roleState('r'))?.state, 'active');
      assert.equal(assignments.value.has('r'), pause === 'scan');
      removalGate.mock.restore();
      intercept.mock.restore();
      creationGate.mock.restore();
    } finally {
      d1Resume.release();
      cResume.release();
      await stub.close();
    }
  });
