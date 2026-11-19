import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fragmentOrdinalMigrationSql } from '../schema.js';
import { perCollectionStoreSql, sharedStoreSql } from '../store-sql.js';

test('record reads bind the primary ordinal and search considers every eligible vector', () => {
  for (const sql of [
    perCollectionStoreSql('docs', 3),
    sharedStoreSql('blue', 'DOCS'),
  ]) {
    for (const statement of [
      sql.byId('id'),
      sql.listPage(undefined, 4, true),
      sql.scanPage(undefined, 4),
      sql.countRows(),
    ])
      assert.match(statement.sql, /"FRAGMENT_ORDINAL" = 0/);
    const filter = {
      nowSecs: 5,
      identity: { ownerScope: 'session', sessionId: 's' },
    } as const;
    const indexed = sql.search('LIT', 3, filter, 6);
    assert.match(indexed.sql, /ORDER BY "score" DESC LIMIT 6/);
    assert.match(indexed.sql, /MAX\("score"\)/);
    assert.match(indexed.sql, /d\."FRAGMENT_ORDINAL" = 0/);
    assert.ok(indexed.params.includes('s'));
    assert.doesNotMatch(
      sql.search('LIT', 3, filter).sql,
      /FROM "DOCS" WHERE [^\n]+ ORDER BY/,
    );
    assert.match(
      sql.upsert('LIT', 'id', 'text', '{}').sql,
      /fragment_ordinal.*VALUES.*0\) WITH PRIMARY KEY/i,
    );
    assert.match(
      sql.insertFragment('id', 1, 'LIT', '{}').sql,
      /"FRAGMENT_ORDINAL"/,
    );
    assert.match(sql.removeFragments('id').sql, /"FRAGMENT_ORDINAL" > 0/);
  }
});

test('migration replaces the key in the same table', () => {
  const sql = fragmentOrdinalMigrationSql('DOCS', 'shared');
  assert.match(
    sql,
    /ALTER TABLE "DOCS" ADD \("FRAGMENT_ORDINAL" INTEGER DEFAULT 0 NOT NULL\)/,
  );
  assert.match(
    sql,
    /ALTER TABLE "DOCS" ADD PRIMARY KEY \("COLLECTION", "ID", "FRAGMENT_ORDINAL"\)/,
  );
});
