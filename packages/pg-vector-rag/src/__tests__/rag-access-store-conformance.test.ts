import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RagError } from '@mcp-abap-adt/llm-agent';
import type { RagAccessBarrierHook } from '@mcp-abap-adt/llm-agent/testing/rag-access-store-conformance';
import { ragAccessStoreConformanceCases } from '@mcp-abap-adt/llm-agent/testing/rag-access-store-conformance';
import { createPgVectorRagAccessStores } from '../access-stores.js';
import { writeCatalogRecord } from '../catalog-record.js';
import { migratePgVectorRagAccess } from '../migrate-access.js';
import { createPgClient } from '../pg-vector-rag.js';
import { PgVectorRagProvider } from '../pg-vector-rag-provider.js';
import { accessFixture } from './access-fixture.js';

for (const item of ragAccessStoreConformanceCases)
  test(`PG ${item.name}`, { skip: !process.env.PG_TEST_URL }, async () => {
    const f = await accessFixture();
    try {
      assert.equal((await migratePgVectorRagAccess(f.provider)).ok, true);
      await f.client.query(
        `INSERT INTO rag_collection_catalog (store_name, collection_name, scope, role_id) VALUES ('used', 'Used', 'role', 'in-use')`,
      );
      await item.run(async () => {
        const stores = createPgVectorRagAccessStores(f.provider);
        let hook: RagAccessBarrierHook = async () => {};
        let raceHooks = {
          deletionPaused: async () => {},
          creationPaused: async () => {},
        };
        const transaction = f.client.transaction?.bind(f.client);
        assert.ok(transaction);
        const creationClient: typeof f.client = {
          ...f.client,
          query: f.client.query.bind(f.client),
          end: async () => {},
          transaction: async (work) => {
            await hook('creation');
            await raceHooks.creationPaused();
            return transaction(work);
          },
        };
        f.client.transaction = async (work) => {
          await hook('deletion');
          return transaction(async (connection) =>
            work({
              ...connection,
              query: async (sql, params) => {
                const rows = await connection.query(sql, params);
                if (sql.includes("WHERE scope = 'role'"))
                  await raceHooks.deletionPaused();
                return rows;
              },
            }),
          );
        };
        return {
          ...stores,
          deletionSerializesCreation: true,
          setDeletionRaceHooks(hooks) {
            raceHooks = hooks;
          },
          async rawCatalogRoleIds() {
            const sql = `SELECT role_id FROM "rag_collection_catalog" WHERE scope = 'role'`;
            return (await f.client.query(sql)).rows.map((row) =>
              String(row.role_id),
            );
          },
          async rawAssignmentRoleIds() {
            const sql = 'SELECT role_id FROM "rag_role_assignments"';
            return (await f.client.query(sql)).rows.map((row) =>
              String(row.role_id),
            );
          },
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
            const result = await f.provider.describeCollections();
            assert.ok(result.ok);
            return result.value.records;
          },
        };
      });
    } finally {
      await f.close();
    }
  });
test('PG two binding-store instances give exactly one ok and persist across factories', {
  skip: !process.env.PG_TEST_URL,
}, async () => {
  const f = await accessFixture();
  const otherClient = await createPgClient(f.connection);
  await otherClient.query(
    `SET search_path TO "${f.connection.schema}", public`,
  );
  const otherProvider = new PgVectorRagProvider({
    name: 'other',
    connection: f.connection,
    embedder: f.embedder,
    clientFactory: () => otherClient,
  });
  try {
    assert.equal((await migratePgVectorRagAccess(f.provider)).ok, true);
    const a = createPgVectorRagAccessStores(f.provider);
    const b = createPgVectorRagAccessStores(otherProvider);
    const results = await Promise.all([
      a.bindings.bind('s', 'u1'),
      b.bindings.bind('s', 'u2'),
    ]);
    assert.equal(results.filter((r) => r.ok).length, 1);
    assert.equal(
      (
        await createPgVectorRagAccessStores(f.provider).bindings.bind(
          's',
          results[0].ok ? 'u1' : 'u2',
        )
      ).ok,
      true,
    );
    assert.ok(
      (
        await a.roles.createRole({
          roleId: 'persisted',
          name: 'Persisted',
          description: 'Saved',
        })
      ).ok,
    );
    assert.ok((await a.roles.assign('u1', 'persisted')).ok);
    assert.deepEqual(await b.roles.listRoles(), {
      ok: true,
      value: [{ roleId: 'persisted', name: 'Persisted', description: 'Saved' }],
    });
    const roles = await b.roles.rolesOf('u1');
    assert.ok(roles.ok);
    assert.deepEqual([...roles.value], ['persisted']);
    const collections = await f.provider.listCollections();
    assert.ok(collections.ok);
    assert.deepEqual(collections.value, []);
    assert.equal((await f.provider.deleteCollection('rag_roles')).ok, false);
  } finally {
    otherProvider.close();
    await otherClient.end();
    await f.close();
  }
});

for (const layout of ['per-collection', 'shared'] as const) {
  test(`PG ${layout} refuses a missing role without writing a catalog row`, {
    skip: !process.env.PG_TEST_URL,
  }, async () => {
    const f = await accessFixture();
    const provider =
      layout === 'shared'
        ? new PgVectorRagProvider({
            name: 'shared',
            connection: f.connection,
            embedder: f.embedder,
            layout,
            catalogTable: 'rag_collection_catalog',
            documentsTable: 'role_docs',
            clientFactory: () => f.client,
          })
        : f.provider;
    try {
      if (layout === 'shared') {
        await f.client.query('CREATE EXTENSION IF NOT EXISTS vector');
        await f.client.query(
          'CREATE TABLE role_docs (collection VARCHAR(63), id VARCHAR(255), text TEXT, vector vector(3), metadata JSONB, PRIMARY KEY (collection, id))',
        );
      }
      assert.ok((await migratePgVectorRagAccess(provider)).ok);
      const result = await provider.createCollection('missing_role', {
        scope: 'role',
        roleId: 'missing',
      });
      assert.equal(result.ok, false);
      const rows = await f.client.query(
        "SELECT 1 FROM rag_collection_catalog WHERE store_name = 'missing_role'",
      );
      assert.equal(rows.rows.length, 0);
    } finally {
      await f.close();
    }
  });
}
