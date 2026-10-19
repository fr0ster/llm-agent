import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createCatalogTableSql } from '../catalog.js';
import { SHIPPED_DIMENSION, sharedLayoutSql } from '../shared-ddl.js';

const DDL_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'ddl',
);

describe('shared-ddl (Postgres)', () => {
  it('sharedLayoutSql emits extension, catalog, documents in order', () => {
    const sql = sharedLayoutSql({ dimension: 1536 });
    const parts = [
      'CREATE EXTENSION IF NOT EXISTS vector',
      createCatalogTableSql('rag_collections'),
      'CREATE TABLE "rag_documents"',
      '"collection" VARCHAR(63) NOT NULL',
      '"id" VARCHAR(255) NOT NULL',
      '"text" TEXT',
      '"vector" vector(1536)',
      '"metadata" JSONB',
      '"created_at" TIMESTAMPTZ DEFAULT NOW()',
      'PRIMARY KEY ("collection", "id")',
    ];
    let at = 0;
    for (const p of parts) {
      const i = sql.indexOf(p, at);
      assert.ok(i >= at, `missing or out of order: ${p}`);
      at = i + p.length;
    }
  });

  it('honours custom table names and dimension', () => {
    const sql = sharedLayoutSql({
      documentsTable: 'docs',
      catalogTable: 'cat',
      dimension: 3,
    });
    assert.match(sql, /CREATE TABLE "docs"/);
    assert.match(sql, /CREATE TABLE "cat"/);
    assert.match(sql, /vector\(3\)/);
  });

  it('rejects an invalid table name', () => {
    assert.throws(
      () => sharedLayoutSql({ documentsTable: 'a-b', dimension: 3 }),
      (e: { code?: string }) => e.code === 'INVALID_COLLECTION_NAME',
    );
  });

  it('shipped ddl files match the generators', () => {
    const files = readdirSync(DDL_DIR);
    assert.deepEqual(files, ['shared-layout.sql']);
    assert.equal(
      readFileSync(join(DDL_DIR, 'shared-layout.sql'), 'utf8'),
      `${sharedLayoutSql({ dimension: SHIPPED_DIMENSION })}\n`,
    );
  });
});
