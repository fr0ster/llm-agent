import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { perCollectionStoreSql, sharedStoreSql } from '../store-sql.js';

describe('shared store SQL', () => {
  const sql = sharedStoreSql('docs', 'RAG_DOCUMENTS');

  it('search filters by collection, first parameter', () => {
    const s = sql.search('LIT');
    assert.equal(
      s.sql,
      'SELECT "ID" AS "id", "TEXT" AS "text", "METADATA" AS "metadata", COSINE_SIMILARITY("VECTOR", LIT) AS "score", "FRAGMENT_VECTORS" AS "fragmentVectors" FROM "RAG_DOCUMENTS" WHERE "COLLECTION" = ? ORDER BY "score" DESC',
    );
    assert.equal(s.params[0], 'docs');
    assert.match(
      sql.search('LIT', 7).sql,
      /WHERE "primaryRank" <= 7 OR "fragmentVectors" IS NOT NULL/,
    );
  });

  it('upsert writes the collection column', () => {
    const s = sql.upsert('LIT', 'a', 't', '{}', null);
    assert.equal(
      s.sql,
      'UPSERT "RAG_DOCUMENTS" ("COLLECTION", "ID", "TEXT", "VECTOR", "METADATA", "FRAGMENT_VECTORS") VALUES (?, ?, ?, LIT, ?, ?) WITH PRIMARY KEY',
    );
    assert.deepEqual(s.params, ['docs', 'a', 't', '{}', null]);
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
  it('per-collection SQL stores fragments with each record', () => {
    const sql = perCollectionStoreSql('docs', 3);
    assert.equal(sql.layout, 'per-collection');
    assert.equal(
      sql.createTable(),
      `CREATE TABLE IF NOT EXISTS "docs" (
    id NVARCHAR(255) PRIMARY KEY,
    text NCLOB,
    vector REAL_VECTOR(3),
    fragment_vectors NCLOB,
    metadata NCLOB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`,
    );
    assert.deepEqual(sql.search('LIT'), {
      sql: 'SELECT id AS "id", text AS "text", metadata AS "metadata", COSINE_SIMILARITY(vector, LIT) AS "score", "FRAGMENT_VECTORS" AS "fragmentVectors" FROM "docs" ORDER BY "score" DESC',
      params: [],
    });
    assert.match(
      sql.search('LIT', 5).sql,
      /WHERE "primaryRank" <= 5 OR "fragmentVectors" IS NOT NULL/,
    );
    assert.deepEqual(sql.byId('a'), {
      sql: 'SELECT id AS "id", text AS "text", metadata AS "metadata" FROM "docs" WHERE id = ?',
      params: ['a'],
    });
    assert.deepEqual(sql.upsert('LIT', 'a', 't', '{}', null), {
      sql: 'UPSERT "docs" (id, text, vector, metadata, fragment_vectors) VALUES (?, ?, LIT, ?, ?) WITH PRIMARY KEY',
      params: ['a', 't', '{}', null],
    });
    assert.deepEqual(sql.deleteById('a'), {
      sql: 'DELETE FROM "docs" WHERE id = ?',
      params: ['a'],
    });
    assert.deepEqual(sql.clear(), { sql: 'TRUNCATE TABLE "docs"', params: [] });
  });
});
