import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { perCollectionStoreSql, sharedStoreSql } from '../store-sql.js';

describe('shared store SQL', () => {
  const sql = sharedStoreSql('docs', 'RAG_DOCUMENTS');

  it('scopes and ranks native vectors before fetching winner LOBs', () => {
    const stmt = sql.search('LIT', 7, {
      nowSecs: 99,
      identity: { ownerScope: 'session', sessionId: 's' },
      namespace: 'ns',
    });
    assert.match(
      stmt.sql,
      /FROM "RAG_DOCUMENTS_FRAGMENTS" AS f INNER JOIN eligible/,
    );
    assert.match(stmt.sql, /MAX\("score"\).*\n\s*GROUP BY "ID".*LIMIT 7/);
    assert.match(stmt.sql, /FROM winners AS w INNER JOIN "RAG_DOCUMENTS"/);
    assert.doesNotMatch(
      stmt.sql.split('SELECT d.')[0],
      /"TEXT"|FRAGMENT_VECTORS/,
    );
    assert.deepEqual(stmt.params, [
      'docs',
      'session',
      's',
      'ns',
      99,
      99,
      'docs',
      'docs',
    ]);
    assert.deepEqual(sql.removeFragments('a').params, ['docs', 'a']);
    assert.deepEqual(sql.insertFragment('a', 4, 'LIT').params, [
      'docs',
      'a',
      4,
    ]);
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
    metadata NCLOB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`,
    );
    const stmt = sql.search('LIT', 5, { nowSecs: 1 });
    assert.match(stmt.sql, /FROM "docs_FRAGMENTS"/);
    assert.match(stmt.sql, /GROUP BY "ID" ORDER BY "score" DESC, "ID" LIMIT 5/);
    assert.deepEqual(stmt.params, [1, 1]);
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
    assert.deepEqual(sql.clear(), { sql: 'DELETE FROM "docs"', params: [] });
  });
});
