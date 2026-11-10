import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RagMetadata } from '@mcp-abap-adt/llm-agent';
import { ragMigrationConformanceCases } from '@mcp-abap-adt/llm-agent/testing/rag-migration-conformance';
import { migrateHanaVectorRagAccess } from '../migrate-access.js';
import { accessFixture } from './access-fixture.js';

for (const layout of ['per-collection', 'shared'] as const)
  test(`HANA ${layout} migrates current-release catalog idempotently and reports invalid owners`, async () => {
    const { db, provider } = accessFixture(layout);
    await db.client.exec('DROP TABLE "rag_collection_catalog"');
    await db.client.exec(`CREATE TABLE "rag_collection_catalog" (
      store_name NVARCHAR(63) PRIMARY KEY,
      collection_name NVARCHAR(5000) NOT NULL,
      scope NVARCHAR(16) NOT NULL,
      user_id NVARCHAR(5000),
      session_id NVARCHAR(5000),
      attributes_json NCLOB,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    db.insertRow('rag_collection_catalog', {
      STORE_NAME: 'valid',
      COLLECTION_NAME: 'Valid',
      SCOPE: 'user',
      USER_ID: 'u',
    });
    db.insertRow('rag_collection_catalog', {
      STORE_NAME: 'invalid',
      COLLECTION_NAME: 'Invalid',
      SCOPE: 'user',
    });
    db.insertRow('rag_collection_catalog', {
      STORE_NAME: 'session',
      COLLECTION_NAME: 'Session',
      SCOPE: 'session',
      SESSION_ID: 's',
    });
    db.insertRow('rag_collection_catalog', {
      STORE_NAME: 'global',
      COLLECTION_NAME: 'Global',
      SCOPE: 'global',
    });
    for (const entry of ragMigrationConformanceCases)
      await entry.run({
        async seedLegacyRecords(records) {
          if (layout === 'per-collection') db.createCollectionTable('valid');
          for (const record of records)
            db.insertRow(layout === 'shared' ? 'RAG_DOCUMENTS' : 'valid', {
              ...(layout === 'shared' ? { COLLECTION: 'valid' } : {}),
              ID: record.id,
              TEXT: record.id,
              VECTOR: [1, 0, 0],
              METADATA: JSON.stringify(record.metadata),
            });
          return 'valid';
        },
        async recordMetadata() {
          const rows = await db.client.query(
            `SELECT "ID" AS "id", "METADATA" AS "metadata" FROM ${layout === 'shared' ? '"RAG_DOCUMENTS"' : '"valid"'} ORDER BY "ID"`,
          );
          return rows.map((row) => ({
            id: String(row.id),
            metadata: JSON.parse(String(row.metadata)) as RagMetadata,
          }));
        },
        migrate: () => migrateHanaVectorRagAccess(provider),
        describe: () => provider.describeCollections(),
        async snapshot() {
          return JSON.stringify({
            documents: await db.client.query(
              `SELECT "ID", "METADATA" FROM ${layout === 'shared' ? '"RAG_DOCUMENTS"' : '"valid"'} ORDER BY "ID"`,
            ),
            rows: await db.client.query(
              'SELECT store_name, scope, user_id, session_id, role_id FROM "rag_collection_catalog" ORDER BY store_name',
            ),
            schema: await db.client.query(
              'SELECT TABLE_NAME, COLUMN_NAME FROM SYS.TABLE_COLUMNS',
            ),
          });
        },
        expectedRecords: [
          { storeName: 'valid', name: 'Valid', scope: 'user', userId: 'u' },
          {
            storeName: 'session',
            name: 'Session',
            scope: 'session',
            sessionId: 's',
          },
          { storeName: 'global', name: 'Global', scope: 'global' },
        ],
        invalidStoreNames: ['invalid'],
      });
    const description = await provider.describeCollections();
    assert.ok(description.ok);
    assert.equal(
      (await db.client.query('SELECT store_name FROM "rag_collection_catalog"'))
        .length,
      4,
    );
    for (const record of description.value.records)
      assert.ok((await provider.openCollection(record)).ok);
  });
