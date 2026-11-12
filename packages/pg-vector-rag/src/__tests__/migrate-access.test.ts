import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RagMetadata } from '@mcp-abap-adt/llm-agent';
import {
  missingRoleMigrationConformanceCase,
  ragMigrationConformanceCases,
} from '@mcp-abap-adt/llm-agent/testing/rag-migration-conformance';
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
      for (const entry of ragMigrationConformanceCases)
        await entry.run({
          supportsOrphans: layout === 'shared',
          async seedLegacyRecords(records, storeName) {
            if (layout === 'per-collection')
              await f.client.query(
                `CREATE TABLE "${storeName}" (id TEXT PRIMARY KEY, metadata JSONB)`,
              );
            for (const record of records)
              await f.client.query(
                layout === 'shared'
                  ? `INSERT INTO migration_docs (collection, id, metadata) VALUES ('${storeName}', $1, $2::jsonb)`
                  : `INSERT INTO "${storeName}" (id, metadata) VALUES ($1, $2::jsonb)`,
                [record.id, JSON.stringify(record.metadata)],
              );
            return storeName;
          },
          async recordMetadata() {
            const result = await f.client.query(
              layout === 'shared'
                ? 'SELECT id, metadata FROM migration_docs ORDER BY id'
                : 'SELECT id, metadata FROM u UNION ALL SELECT id, metadata FROM s ORDER BY id',
            );
            return result.rows.map((row) => ({
              id: String(row.id),
              metadata: row.metadata as RagMetadata,
            }));
          },
          migrate: () => migratePgVectorRagAccess(provider),
          describe: () => provider.describeCollections(),
          async snapshot() {
            return JSON.stringify({
              documents: await f.client.query(
                layout === 'shared'
                  ? 'SELECT id, metadata FROM migration_docs ORDER BY id'
                  : 'SELECT id, metadata FROM u UNION ALL SELECT id, metadata FROM s ORDER BY id',
              ),
              rows: await f.client.query(
                'SELECT * FROM rag_collection_catalog ORDER BY store_name',
              ),
              schema: await f.client.query(
                'SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = current_schema() ORDER BY table_name, ordinal_position',
              ),
            });
          },
          expectedRecords: [
            { storeName: 'u', name: 'User', scope: 'user', userId: 'u1' },
            {
              storeName: 's',
              name: 'Session',
              scope: 'session',
              sessionId: 's1',
            },
            { storeName: 'g', name: 'Global', scope: 'global' },
          ],
          invalidStoreNames: ['bad'],
        });
      await missingRoleMigrationConformanceCase.run({
        async seedMissingRole() {
          await f.client.query(
            "INSERT INTO rag_collection_catalog (store_name, collection_name, scope, role_id) VALUES ('orphan', 'Orphan', 'role', 'missing')",
          );
        },
        migrate: () => migratePgVectorRagAccess(provider),
        describe: () => provider.describeCollections(),
      });
      await f.client.query(
        "INSERT INTO rag_collection_catalog (store_name, collection_name, scope, role_id) VALUES ('role_docs', 'Role Docs', 'role', 'r1')",
      );
      const migrated = await migratePgVectorRagAccess(provider);
      assert.ok(migrated.ok);
      assert.ok(
        migrated.value.reported.some((row) => row.storeName === 'role_docs'),
      );
      const catalog = await provider.describeCollections();
      assert.ok(catalog.ok);
      assert.equal(
        catalog.value.records.some((row) => row.storeName === 'role_docs'),
        false,
      );
    } finally {
      provider.close();
      await f.close();
    }
  });
