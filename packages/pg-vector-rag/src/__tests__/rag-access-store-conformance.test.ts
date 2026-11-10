import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ragAccessStoreConformanceCases } from '@mcp-abap-adt/llm-agent/testing/rag-access-store-conformance';
import { createPgVectorRagAccessStores } from '../access-stores.js';
import { migratePgVectorRagAccess } from '../migrate-access.js';
import { createPgClient, type PgClient } from '../pg-vector-rag.js';
import { PgVectorRagProvider } from '../pg-vector-rag-provider.js';
import { accessFixture } from './access-fixture.js';

function barrier() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

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

test('PG deletion wins a barrier-controlled role collection creation without leaving an orphan owner', {
  skip: !process.env.PG_TEST_URL,
}, async () => {
  const f = await accessFixture();
  const entered = barrier();
  const resume = barrier();
  const { writeCatalogRecord } = await import('../catalog-record.js');
  const { RagError } = await import('@mcp-abap-adt/llm-agent');
  try {
    assert.ok((await migratePgVectorRagAccess(f.provider)).ok);
    const stores = createPgVectorRagAccessStores(f.provider);
    assert.ok(
      (await stores.roles.createRole({ roleId: 'race', name: 'Race' })).ok,
    );
    // PGlite serializes transactions; drive the persistence boundary step-wise.
    const wait = async () => {
      entered.resolve();
      await resume.promise;
    };
    const gated: PgClient = {
      query: async (sql, params) => {
        await wait();
        return f.client.query(sql, params);
      },
      end: async () => {},
      transaction: async (work) => {
        await wait();
        assert.ok(f.client.transaction);
        return f.client.transaction(work);
      },
    };
    const creation = writeCatalogRecord(
      gated,
      'rag_collection_catalog',
      { storeName: 'race_docs', name: 'Race', scope: 'role', roleId: 'race' },
      { scope: 'role', roleId: 'race' },
      () => ({ ok: false, error: new RagError('Refused', 'RAG_CREATE_ERROR') }),
    );
    await entered.promise;
    assert.ok((await stores.roles.deleteRole('race')).ok);
    resume.resolve();
    assert.equal((await creation).ok, false);
    assert.equal(
      (
        await f.client.query(
          "SELECT 1 FROM rag_collection_catalog WHERE role_id = 'race'",
        )
      ).rows.length,
      0,
    );
  } finally {
    resume.resolve();
    await f.close();
  }
});

test('PG collection creation wins and deletion preserves its role and assignments', {
  skip: !process.env.PG_TEST_URL,
}, async () => {
  const f = await accessFixture();
  const { writeCatalogRecord } = await import('../catalog-record.js');
  const { RagError, RoleInUseError } = await import('@mcp-abap-adt/llm-agent');
  const created = barrier();
  try {
    assert.ok((await migratePgVectorRagAccess(f.provider)).ok);
    const roles = createPgVectorRagAccessStores(f.provider).roles;
    assert.ok(
      (await roles.createRole({ roleId: 'winner', name: 'Winner' })).ok,
    );
    assert.ok((await roles.assign('u1', 'winner')).ok);
    const creation = (async () => {
      const result = await writeCatalogRecord(
        f.client,
        'rag_collection_catalog',
        {
          storeName: 'winner_docs',
          name: 'Winner',
          scope: 'role',
          roleId: 'winner',
        },
        { scope: 'role', roleId: 'winner' },
        () => ({
          ok: false,
          error: new RagError('Refused', 'RAG_CREATE_ERROR'),
        }),
      );
      created.resolve();
      return result;
    })();
    const deletion = (async () => {
      await created.promise;
      return roles.deleteRole('winner');
    })();
    assert.ok((await creation).ok);
    const result = await deletion;
    assert.ok(!result.ok);
    assert.ok(result.error instanceof RoleInUseError);
    assert.equal(
      (
        await f.client.query(
          "SELECT 1 FROM rag_collection_catalog c JOIN rag_roles r ON c.role_id = r.role_id WHERE c.store_name = 'winner_docs'",
        )
      ).rows.length,
      1,
    );
    const assigned = await roles.rolesOf('u1');
    assert.ok(assigned.ok);
    assert.ok(assigned.value.has('winner'));
  } finally {
    created.resolve();
    await f.close();
  }
});
