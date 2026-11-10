import assert from 'node:assert/strict';
import { test } from 'node:test';
import { migratePgVectorRagAccess } from '../migrate-access.js';
import { PgVectorRagProvider } from '../pg-vector-rag-provider.js';
import { accessFixture } from './access-fixture.js';

for (const layout of ['per-collection', 'shared'] as const)
  test(`PG ${layout} current-release catalog migration preserves owners, reports invalid owners and is idempotent`, {
    skip: !process.env.PG_TEST_URL,
  }, async () => {
    const f = await accessFixture();
    const provider =
      layout === 'per-collection'
        ? f.provider
        : new PgVectorRagProvider({
            name: 'shared',
            connection: f.connection,
            embedder: f.embedder,
            layout,
            catalogTable: 'rag_collection_catalog',
            documentsTable: 'migration_docs',
            clientFactory: () => f.client,
          });
    try {
      if (layout === 'shared') {
        await f.client.query('CREATE EXTENSION IF NOT EXISTS vector');
        await f.client.query(
          'CREATE TABLE migration_docs (collection VARCHAR(63), id VARCHAR(255), text TEXT, vector vector(3), metadata JSONB, PRIMARY KEY (collection, id))',
        );
      }
      await f.client.query(
        `CREATE TABLE rag_collection_catalog (store_name VARCHAR(63) PRIMARY KEY, collection_name TEXT NOT NULL, scope VARCHAR(16) NOT NULL, user_id TEXT, session_id TEXT, attributes_json TEXT, created_at TIMESTAMPTZ DEFAULT NOW())`,
      );
      await f.client.query(
        `INSERT INTO rag_collection_catalog (store_name, collection_name, scope, user_id, session_id) VALUES ('u', 'User', 'user', 'u1', NULL), ('s', 'Session', 'session', NULL, 's1'), ('g', 'Global', 'global', NULL, NULL), ('bad', 'Invalid', 'user', NULL, NULL)`,
      );
      const first = await migratePgVectorRagAccess(provider);
      assert.ok(first.ok);
      assert.deepEqual(
        first.value.reported.map((r) => r.storeName),
        ['bad'],
      );
      const description = await provider.describeCollections();
      assert.ok(description.ok);
      assert.deepEqual(
        description.value.records.map((r) => r.storeName),
        ['g', 's', 'u'],
      );
      assert.equal(
        description.value.records.find((r) => r.scope === 'user')?.userId,
        'u1',
      );
      const rows = await f.client.query(
        'SELECT * FROM rag_collection_catalog ORDER BY store_name',
      );
      const schema = await f.client.query(
        `SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = current_schema() ORDER BY table_name, ordinal_position`,
      );
      assert.deepEqual(await migratePgVectorRagAccess(provider), first);
      assert.deepEqual(
        await f.client.query(
          'SELECT * FROM rag_collection_catalog ORDER BY store_name',
        ),
        rows,
      );
      assert.deepEqual(
        await f.client.query(
          `SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = current_schema() ORDER BY table_name, ordinal_position`,
        ),
        schema,
      );
      const created = await provider.createCollection('role_docs', {
        scope: 'role',
        roleId: 'r1',
      });
      assert.ok(created.ok);
      const catalog = await provider.describeCollections();
      assert.ok(catalog.ok);
      const role = catalog.value.records.find((r) => r.scope === 'role');
      assert.ok(role);
      assert.equal(role.roleId, 'r1');
      assert.ok((await provider.openCollection(role)).ok);
    } finally {
      provider.close();
      await f.close();
    }
  });
