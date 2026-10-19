import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { perCollectionStoreSql, sharedStoreSql } from '../store-sql.js';

const TTL = `COALESCE(CASE WHEN jsonb_typeof(metadata->'ttl') = 'number' THEN (metadata->>'ttl')::float8 END, 'infinity'::float8) >=`;
const TTL_SHARED = `COALESCE(CASE WHEN jsonb_typeof("metadata"->'ttl') = 'number' THEN ("metadata"->>'ttl')::float8 END, 'infinity'::float8) >=`;

describe('shared store SQL', () => {
  const sql = sharedStoreSql('docs', 'rag_documents');

  it('search filters by collection, $1, and renumbers the other conditions', () => {
    const plain = sql.search('LIT', 7, { nowSecs: 99 });
    assert.equal(
      plain.sql,
      `SELECT "id", "text", "metadata", "vector" <=> LIT AS score FROM "rag_documents" WHERE "collection" = $1 AND ${TTL_SHARED} $2 ORDER BY "vector" <=> LIT LIMIT 7`,
    );
    assert.deepEqual(plain.params, ['docs', 99]);
    const scoped = sql.search('LIT', 3, {
      identity: { sessionId: 's', userId: 'u' },
      namespace: 'ns',
      nowSecs: 5,
    });
    assert.equal(
      scoped.sql,
      `SELECT "id", "text", "metadata", "vector" <=> LIT AS score FROM "rag_documents" WHERE "collection" = $1 AND CASE WHEN jsonb_typeof("metadata"->'sessionId') = 'string' THEN "metadata"->>'sessionId' END = $2 AND CASE WHEN jsonb_typeof("metadata"->'userId') = 'string' THEN "metadata"->>'userId' END = $3 AND CASE WHEN jsonb_typeof("metadata"->'namespace') = 'string' THEN "metadata"->>'namespace' END = $4 AND ${TTL_SHARED} $5 ORDER BY "vector" <=> LIT LIMIT 3`,
    );
    assert.deepEqual(scoped.params, ['docs', 's', 'u', 'ns', 5]);
  });

  it('upsert writes the collection column', () => {
    const s = sql.upsert('LIT', 'a', 't', '{}');
    assert.equal(
      s.sql,
      'INSERT INTO "rag_documents" ("collection", "id", "text", "vector", "metadata") VALUES ($1, $2, $3, LIT, $4::jsonb) ON CONFLICT ("collection", "id") DO UPDATE SET "text" = EXCLUDED."text", "vector" = EXCLUDED."vector", "metadata" = EXCLUDED."metadata"',
    );
    assert.deepEqual(s.params, ['docs', 'a', 't', '{}']);
  });

  it('clear is a DELETE, never a TRUNCATE; createTable is undefined', () => {
    assert.equal(
      sql.clear().sql,
      'DELETE FROM "rag_documents" WHERE "collection" = $1',
    );
    assert.doesNotMatch(sql.clear().sql, /TRUNCATE/i);
    assert.equal(sql.createTable(), undefined);
    assert.deepEqual(sql.clear().params, ['docs']);
  });

  it('byId, deleteById and countRows are scoped to the collection', () => {
    assert.deepEqual(sql.byId('x'), {
      sql: 'SELECT "id", "text", "metadata" FROM "rag_documents" WHERE "collection" = $1 AND "id" = $2',
      params: ['docs', 'x'],
    });
    assert.deepEqual(sql.deleteById('x'), {
      sql: 'DELETE FROM "rag_documents" WHERE "collection" = $1 AND "id" = $2',
      params: ['docs', 'x'],
    });
    assert.deepEqual(sql.countRows(), {
      sql: 'SELECT COUNT(*) AS n FROM "rag_documents" WHERE "collection" = $1',
      params: ['docs'],
    });
  });
});

describe('per-collection store SQL', () => {
  it('per-collection SQL is unchanged (pinned literals from 30.1.0)', () => {
    const sql = perCollectionStoreSql('docs', 3);
    assert.equal(sql.layout, 'per-collection');
    assert.equal(
      sql.createTable(),
      `CREATE TABLE IF NOT EXISTS "docs" (
    id VARCHAR(255) PRIMARY KEY,
    text TEXT,
    vector vector(3),
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`,
    );
    assert.deepEqual(sql.search('LIT', 5, { nowSecs: 42 }), {
      sql: `SELECT id, text, metadata, vector <=> LIT AS score FROM "docs" WHERE ${TTL} $1 ORDER BY vector <=> LIT LIMIT 5`,
      params: [42],
    });
    assert.deepEqual(
      sql.search('LIT', 1, {
        identity: { sessionId: 's', userId: 'u' },
        namespace: 'ns',
        nowSecs: 42,
      }),
      {
        sql: `SELECT id, text, metadata, vector <=> LIT AS score FROM "docs" WHERE metadata->>'sessionId' = $1 AND metadata->>'userId' = $2 AND metadata->>'namespace' = $3 AND ${TTL} $4 ORDER BY vector <=> LIT LIMIT 1`,
        params: ['s', 'u', 'ns', 42],
      },
    );
    assert.deepEqual(sql.byId('a'), {
      sql: 'SELECT id, text, metadata FROM "docs" WHERE id = $1',
      params: ['a'],
    });
    assert.deepEqual(sql.upsert('LIT', 'a', 't', '{}'), {
      sql: 'INSERT INTO "docs" (id, text, vector, metadata) VALUES ($1, $2, LIT, $3::jsonb) ON CONFLICT (id) DO UPDATE SET text = EXCLUDED.text, vector = EXCLUDED.vector, metadata = EXCLUDED.metadata',
      params: ['a', 't', '{}'],
    });
    assert.deepEqual(sql.deleteById('a'), {
      sql: 'DELETE FROM "docs" WHERE id = $1',
      params: ['a'],
    });
    assert.deepEqual(sql.clear(), { sql: 'TRUNCATE "docs"', params: [] });
  });
});
