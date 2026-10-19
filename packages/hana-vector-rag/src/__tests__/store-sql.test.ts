import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { perCollectionStoreSql, sharedStoreSql } from '../store-sql.js';

describe('shared store SQL', () => {
  const sql = sharedStoreSql('docs', 'RAG_DOCUMENTS');

  it('search filters by collection, first parameter', () => {
    const s = sql.search('LIT');
    assert.equal(
      s.sql,
      'SELECT "ID" AS "id", "TEXT" AS "text", "METADATA" AS "metadata", COSINE_SIMILARITY("VECTOR", LIT) AS "score" FROM "RAG_DOCUMENTS" WHERE "COLLECTION" = ? ORDER BY "score" DESC',
    );
    assert.equal(s.params[0], 'docs');
    assert.ok(sql.search('LIT', 7).sql.endsWith(' LIMIT 7'));
  });

  it('upsert writes the collection column', () => {
    const s = sql.upsert('LIT', 'a', 't', '{}');
    assert.equal(
      s.sql,
      'UPSERT "RAG_DOCUMENTS" ("COLLECTION", "ID", "TEXT", "VECTOR", "METADATA") VALUES (?, ?, ?, LIT, ?) WITH PRIMARY KEY',
    );
    assert.deepEqual(s.params, ['docs', 'a', 't', '{}']);
  });

  it('clear is a DELETE, never a TRUNCATE; createTable is undefined', () => {
    assert.match(sql.clear().sql, /^DELETE FROM "RAG_DOCUMENTS" WHERE/);
    assert.doesNotMatch(sql.clear().sql, /TRUNCATE/i);
    assert.equal(sql.createTable(), undefined);
    assert.deepEqual(sql.clear().params, ['docs']);
  });

  it('byId, deleteById and countRows are scoped to the collection', () => {
    assert.deepEqual(sql.byId('x').params, ['docs', 'x']);
    assert.deepEqual(sql.deleteById('x').params, ['docs', 'x']);
    assert.deepEqual(sql.countRows().params, ['docs']);
    assert.match(sql.countRows().sql, /^SELECT COUNT\(\*\) AS "n" /);
  });
});

describe('per-collection store SQL', () => {
  it('per-collection SQL is unchanged except the aliases', () => {
    const sql = perCollectionStoreSql('docs', 3);
    assert.equal(sql.layout, 'per-collection');
    assert.equal(
      sql.createTable(),
      `CREATE TABLE IF NOT EXISTS "docs" (
    id NVARCHAR(255) PRIMARY KEY,
    text NCLOB,
    vector REAL_VECTOR(3),
    metadata NCLOB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`,
    );
    assert.deepEqual(sql.search('LIT'), {
      sql: 'SELECT id AS "id", text AS "text", metadata AS "metadata", COSINE_SIMILARITY(vector, LIT) AS "score" FROM "docs" ORDER BY "score" DESC',
      params: [],
    });
    assert.equal(
      sql.search('LIT', 5).sql,
      'SELECT id AS "id", text AS "text", metadata AS "metadata", COSINE_SIMILARITY(vector, LIT) AS "score" FROM "docs" ORDER BY "score" DESC LIMIT 5',
    );
    assert.deepEqual(sql.byId('a'), {
      sql: 'SELECT id AS "id", text AS "text", metadata AS "metadata" FROM "docs" WHERE id = ?',
      params: ['a'],
    });
    assert.deepEqual(sql.upsert('LIT', 'a', 't', '{}'), {
      sql: 'UPSERT "docs" (id, text, vector, metadata) VALUES (?, ?, LIT, ?) WITH PRIMARY KEY',
      params: ['a', 't', '{}'],
    });
    assert.deepEqual(sql.deleteById('a'), {
      sql: 'DELETE FROM "docs" WHERE id = ?',
      params: ['a'],
    });
    assert.deepEqual(sql.clear(), { sql: 'TRUNCATE TABLE "docs"', params: [] });
  });
});
