import assert from 'node:assert/strict';
import { test } from 'node:test';
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
    const first = await migrateHanaVectorRagAccess(provider);
    assert.ok(first.ok);
    assert.equal(first.value.reported[0]?.storeName, 'invalid');
    const rows = await db.client.query(
      'SELECT store_name, scope, user_id, session_id, role_id FROM "rag_collection_catalog" ORDER BY store_name',
    );
    const snapshot = await db.client.query(
      'SELECT TABLE_NAME, COLUMN_NAME FROM SYS.TABLE_COLUMNS',
    );
    assert.deepEqual(await migrateHanaVectorRagAccess(provider), first);
    assert.deepEqual(
      await db.client.query(
        'SELECT TABLE_NAME, COLUMN_NAME FROM SYS.TABLE_COLUMNS',
      ),
      snapshot,
    );
    assert.deepEqual(
      await db.client.query(
        'SELECT store_name, scope, user_id, session_id, role_id FROM "rag_collection_catalog" ORDER BY store_name',
      ),
      rows,
    );
    const description = await provider.describeCollections();
    assert.ok(description.ok);
    assert.deepEqual(
      description.value.records.map((r) => [
        r.storeName,
        r.scope,
        r.scope === 'user' ? r.userId : '',
      ]),
      [
        ['global', 'global', ''],
        ['session', 'session', ''],
        ['valid', 'user', 'u'],
      ],
    );
    assert.equal(
      (await db.client.query('SELECT store_name FROM "rag_collection_catalog"'))
        .length,
      4,
    );
    for (const record of description.value.records)
      assert.ok((await provider.openCollection(record)).ok);
  });
