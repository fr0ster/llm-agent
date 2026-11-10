import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ragAccessStoreConformanceCases } from '@mcp-abap-adt/llm-agent/testing/rag-access-store-conformance';
import { createPgVectorRagAccessStores } from '../access-stores.js';
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
      await item.run(async () => createPgVectorRagAccessStores(f.provider));
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
