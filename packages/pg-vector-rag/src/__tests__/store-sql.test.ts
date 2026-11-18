import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fragmentStorageSql } from '../schema.js';
import { perCollectionStoreSql, sharedStoreSql } from '../store-sql.js';

describe('shared store SQL', () => {
  const sql = sharedStoreSql('docs', 'rag_documents');

  it('search filters by collection, $1, and renumbers the other conditions', () => {
    const plain = sql.search('LIT', 7, { nowSecs: 99 });
    assert.match(plain.sql, /FROM "rag_documents_fragments" AS f/);
    assert.match(plain.sql, /ORDER BY f\."vector" <=> LIT LIMIT 1/);
    assert.match(plain.sql, /GROUP BY id ORDER BY distance, id LIMIT 7/);
    assert.match(plain.sql, /FROM winners AS w JOIN "rag_documents"/);
    assert.doesNotMatch(plain.sql, /unnest|fragment_vectors/);
    assert.deepEqual(plain.params, ['docs', 99]);
    const scoped = sql.search('LIT', 3, {
      identity: { ownerScope: 'session', sessionId: 's', userId: 'u' },
      namespace: 'ns',
      nowSecs: 5,
    });
    assert.match(scoped.sql, /f\."collection" = \$1/);
    assert.match(
      scoped.sql,
      /jsonb_typeof\("metadata"->'namespace'\) = 'string'.*= \$5/,
    );
    assert.deepEqual(scoped.params, ['docs', 'session', 's', 'u', 'ns', 5]);
  });

  it('upsert writes the collection column', () => {
    const s = sql.upsert('LIT', 'a', 't', '{}', null);
    assert.equal(
      s.sql,
      'INSERT INTO "rag_documents" ("collection", "id", "text", "vector", "metadata", "fragment_vectors") VALUES ($1, $2, $3, LIT, $4::jsonb, $5::vector[]) ON CONFLICT ("collection", "id") DO UPDATE SET "text" = EXCLUDED."text", "vector" = EXCLUDED."vector", "metadata" = EXCLUDED."metadata", "fragment_vectors" = EXCLUDED."fragment_vectors"',
    );
    assert.deepEqual(s.params, ['docs', 'a', 't', '{}', null]);
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
  it('per-collection SQL stores fragments with each record', () => {
    const sql = perCollectionStoreSql('docs', 3);
    assert.equal(sql.layout, 'per-collection');
    assert.equal(
      sql.createTable(),
      `CREATE TABLE IF NOT EXISTS "docs" (
    id VARCHAR(255) PRIMARY KEY,
    text TEXT,
    vector vector(3),
    fragment_vectors vector(3)[],
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`,
    );
    const query = sql.search('LIT', 5, { nowSecs: 42 });
    assert.match(query.sql, /FROM "docs_fragments" AS f/);
    assert.match(query.sql, /winners AS \(/);
    assert.deepEqual(query.params, [42]);
    assert.deepEqual(sql.byId('a'), {
      sql: 'SELECT id, text, metadata FROM "docs" WHERE id = $1',
      params: ['a'],
    });
    assert.deepEqual(sql.upsert('LIT', 'a', 't', '{}', null), {
      sql: 'INSERT INTO "docs" (id, text, vector, metadata, fragment_vectors) VALUES ($1, $2, LIT, $3::jsonb, $4::vector[]) ON CONFLICT (id) DO UPDATE SET text = EXCLUDED.text, vector = EXCLUDED.vector, metadata = EXCLUDED.metadata, fragment_vectors = EXCLUDED.fragment_vectors',
      params: ['a', 't', '{}', null],
    });
    assert.deepEqual(sql.deleteById('a'), {
      sql: 'DELETE FROM "docs" WHERE id = $1',
      params: ['a'],
    });
    assert.deepEqual(sql.clear(), {
      sql: 'TRUNCATE "docs", "docs_fragments"',
      params: [],
    });
  });
});

it('migration builds a cosine index and atomically maintains the fragment projection', () => {
  const ddl = fragmentStorageSql(
    'rag_documents',
    1536,
    'shared',
    'tenant',
  ).join('\n');
  assert.match(
    ddl,
    /"tenant"\."rag_documents_fragments" USING hnsw \("vector" vector_cosine_ops\)/,
  );
  assert.match(ddl, /FOREIGN KEY \("collection", "id"\).*ON DELETE CASCADE/);
  assert.match(ddl, /AFTER INSERT OR UPDATE OF "fragment_vectors"/);
  assert.match(ddl, /unnest\(NEW\."fragment_vectors"\) WITH ORDINALITY/);
});
