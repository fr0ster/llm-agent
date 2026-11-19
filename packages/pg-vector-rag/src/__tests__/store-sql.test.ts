import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fragmentOrdinalMigrationSql } from '../schema.js';
import { perCollectionStoreSql, sharedStoreSql } from '../store-sql.js';

test('record reads bind the primary ordinal and search considers every eligible vector', () => {
  for (const sql of [
    perCollectionStoreSql('docs', 3),
    sharedStoreSql('blue', 'docs', 'tenant'),
  ]) {
    for (const statement of [
      sql.byId('id'),
      sql.listPage(undefined, 4, true),
      sql.scanPage(undefined, 4),
      sql.countRows(),
    ])
      assert.match(statement.sql, /fragment_ordinal"? = 0/);
    const filter = {
      nowSecs: 5,
      identity: { ownerScope: 'session', sessionId: 's' },
    } as const;
    const indexed = sql.search('LIT', 3, filter, 6);
    assert.match(indexed.sql, /ORDER BY "vector" <=> LIT LIMIT 6/);
    assert.match(indexed.sql, /MIN\(distance\)/);
    assert.match(indexed.sql, /d\."fragment_ordinal" = 0/);
    assert.ok(indexed.params.includes('s'));
    assert.doesNotMatch(sql.search('LIT', 3, filter).sql, /ORDER BY "vector"/);
    assert.match(
      sql.upsert('LIT', 'id', 'text', '{}').sql,
      /ON CONFLICT \([^)]*fragment_ordinal/,
    );
    assert.match(
      sql.insertFragments('id', ['[1,0,1]'], '{}').sql,
      /WITH ORDINALITY/,
    );
    assert.match(sql.removeFragments('id').sql, /fragment_ordinal"? > 0/);
  }
});

test('migration replaces the primary key in place and defaults old ordinals to zero', () => {
  const sql = fragmentOrdinalMigrationSql('docs', 'shared', 'tenant');
  assert.match(sql, /ALTER TABLE "tenant"\."docs" DROP CONSTRAINT/);
  assert.match(sql, /integer NOT NULL DEFAULT 0/);
  assert.match(sql, /PRIMARY KEY \("collection", "id", fragment_ordinal\)/);
});
