import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RagError } from '@mcp-abap-adt/llm-agent';
import type { RagAccessBarrierHook } from '@mcp-abap-adt/llm-agent/testing/rag-access-store-conformance';
import { ragAccessStoreConformanceCases } from '@mcp-abap-adt/llm-agent/testing/rag-access-store-conformance';
import { createHanaVectorRagAccessStores } from '../access-stores.js';
import { writeCatalogRecord } from '../catalog-record.js';
import { migrateHanaVectorRagAccess } from '../migrate-access.js';
import { accessFixture } from './access-fixture.js';

for (const item of ragAccessStoreConformanceCases)
  test(`HANA ${item.name}`, async () => {
    const { db, provider } = accessFixture();
    assert.ok((await migrateHanaVectorRagAccess(provider)).ok);
    db.insertRow('rag_collection_catalog', {
      STORE_NAME: 'used',
      COLLECTION_NAME: 'Used',
      SCOPE: 'role',
      ROLE_ID: 'in-use',
    });
    await item.run(async () => {
      const stores = createHanaVectorRagAccessStores(provider);
      let hook: RagAccessBarrierHook = async () => {};
      const transaction = db.client.transaction?.bind(db.client);
      assert.ok(transaction);
      const creationClient: typeof db.client = {
        ...db.client,
        query: db.client.query.bind(db.client),
        exec: db.client.exec.bind(db.client),
        transaction: async (work) => {
          await hook('creation');
          return transaction(work);
        },
      };
      db.client.transaction = async (work) => {
        await hook('deletion');
        return transaction(work);
      };
      return {
        ...stores,
        setBarrierHook(next) {
          hook = next;
        },
        async createRoleCollection(roleId) {
          const result = await writeCatalogRecord(
            creationClient,
            'rag_collection_catalog',
            {
              storeName: `docs_${roleId}`,
              name: 'Docs',
              scope: 'role',
              roleId,
            },
            { scope: 'role', roleId },
            () => ({
              ok: false,
              error: new RagError('Refused', 'RAG_CREATE_ERROR'),
            }),
          );
          return result.ok ? { ok: true, value: undefined } : result;
        },
        async collections() {
          const result = await provider.describeCollections();
          assert.ok(result.ok);
          return result.value.records;
        },
      };
    });
  });

test('HANA two binding stores persist exactly one concurrent winner', async () => {
  const { provider } = accessFixture();
  assert.ok((await migrateHanaVectorRagAccess(provider)).ok);
  const { HanaVectorRagProvider } = await import(
    '../hana-vector-rag-provider.js'
  );
  const { staticLogin, symmetricEmbedder } = await import(
    '@mcp-abap-adt/llm-agent'
  );
  const client = (await provider.accessPersistence()).client;
  const other = new HanaVectorRagProvider({
    name: 'other',
    connection: { collectionName: 'unused', credential: staticLogin('u', 'p') },
    embedder: symmetricEmbedder({ embed: async () => ({ vector: [1, 0, 0] }) }),
    clientFactory: () => ({ ...client }),
  });
  const a = createHanaVectorRagAccessStores(provider);
  const b = createHanaVectorRagAccessStores(other);
  const results = await Promise.all([
    a.bindings.bind('s', 'u1'),
    b.bindings.bind('s', 'u2'),
  ]);
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.ok(
    (
      await createHanaVectorRagAccessStores(provider).bindings.bind(
        's',
        results[0].ok ? 'u1' : 'u2',
      )
    ).ok,
  );
});

for (const layout of ['per-collection', 'shared'] as const)
  test(`HANA ${layout} role collection creation refuses missing roles and prevents deleting used roles`, async () => {
    const { provider } = accessFixture(layout);
    assert.ok((await migrateHanaVectorRagAccess(provider)).ok);
    const roles = createHanaVectorRagAccessStores(provider).roles;
    assert.equal(
      (
        await provider.createCollection('missing', {
          scope: 'role',
          roleId: 'missing',
        })
      ).ok,
      false,
    );
    assert.ok((await roles.createRole({ roleId: 'r', name: 'Role' })).ok);
    assert.ok(
      (await provider.createCollection('owned', { scope: 'role', roleId: 'r' }))
        .ok,
    );
    assert.equal((await roles.deleteRole('r')).ok, false);
    const description = await provider.describeCollections();
    assert.ok(description.ok);
    assert.deepEqual(
      description.value.records.map((r) =>
        r.scope === 'role' ? r.roleId : '',
      ),
      ['r'],
    );
  });

function barrier() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

for (const first of ['creation', 'deletion'] as const)
  test(`HANA role ${first} wins a barrier-controlled race`, async () => {
    const { db, provider } = accessFixture();
    assert.ok((await migrateHanaVectorRagAccess(provider)).ok);
    const roles = createHanaVectorRagAccessStores(provider).roles;
    assert.ok((await roles.createRole({ roleId: 'race', name: 'Race' })).ok);
    assert.ok((await roles.assign('u', 'race')).ok);
    const entered = barrier();
    const resume = barrier();
    const { writeCatalogRecord } = await import('../catalog-record.js');
    const { RagError, RoleInUseError } = await import(
      '@mcp-abap-adt/llm-agent'
    );
    const { HanaVectorRagProvider } = await import(
      '../hana-vector-rag-provider.js'
    );
    const persistence = await provider.accessPersistence();
    const gated = new HanaVectorRagProvider({
      name: 'gated',
      connection: {
        collectionName: 'unused',
        credential: (await import('@mcp-abap-adt/llm-agent')).staticLogin(
          'u',
          'p',
        ),
      },
      embedder: (await import('@mcp-abap-adt/llm-agent')).symmetricEmbedder({
        embed: async () => ({ vector: [1, 0, 0] }),
      }),
      clientFactory: () => ({
        ...db.client,
        transaction: (work) => {
          assert.ok(db.client.transaction);
          return db.client.transaction(async (connection) =>
            work({
              ...connection,
              query: async (sql, params) => {
                const rows = await connection.query(sql, params);
                if (sql.includes('FOR UPDATE')) {
                  entered.resolve();
                  await resume.promise;
                }
                return rows;
              },
            }),
          );
        },
      }),
    });
    const gatedClient = (await gated.accessPersistence()).client;
    const create = (client: typeof gatedClient) =>
      writeCatalogRecord(
        client,
        persistence.catalogTable,
        { storeName: 'race_docs', name: 'Race', scope: 'role', roleId: 'race' },
        { scope: 'role', roleId: 'race' },
        () => ({
          ok: false,
          error: new RagError('Refused', 'RAG_CREATE_ERROR'),
        }),
      );
    try {
      if (first === 'creation') {
        const creation = create(gatedClient);
        await entered.promise;
        const deletion = roles.deleteRole('race');
        resume.resolve();
        assert.ok((await creation).ok);
        const result = await deletion;
        assert.ok(!result.ok && result.error instanceof RoleInUseError);
        const assigned = await roles.rolesOf('u');
        assert.ok(assigned.ok && assigned.value.has('race'));
      } else {
        const deletion =
          createHanaVectorRagAccessStores(gated).roles.deleteRole('race');
        await entered.promise;
        const creation = create(db.client);
        resume.resolve();
        assert.ok((await deletion).ok);
        assert.equal((await creation).ok, false);
        assert.equal(
          (
            await db.client.query(
              'SELECT store_name FROM "rag_collection_catalog"',
            )
          ).length,
          0,
        );
      }
      assert.ok(
        db.statements.some(
          (sql) =>
            sql.includes('FROM "rag_roles"') && sql.endsWith('FOR UPDATE'),
        ),
      );
    } finally {
      resume.resolve();
      gated.close();
      provider.close();
    }
  });
