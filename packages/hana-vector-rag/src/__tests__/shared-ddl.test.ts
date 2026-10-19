import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createCatalogTableSql } from '../catalog.js';
import {
  SHARED_CATALOG_TABLE,
  SHARED_DOCUMENTS_TABLE,
  SHIPPED_DIMENSION,
  sharedCatalogHdbtable,
  sharedDocumentsHdbtable,
  sharedLayoutSql,
} from '../shared-ddl.js';

const DDL_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'ddl',
);

describe('shared-ddl (HANA)', () => {
  it('sharedDocumentsHdbtable emits the documents table', () => {
    assert.equal(
      sharedDocumentsHdbtable('RAG_DOCUMENTS', 1536),
      `COLUMN TABLE "RAG_DOCUMENTS" (
  "COLLECTION" NVARCHAR(63) NOT NULL,
  "ID" NVARCHAR(255) NOT NULL,
  "TEXT" NCLOB,
  "VECTOR" REAL_VECTOR(1536),
  "METADATA" NCLOB,
  "CREATED_AT" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("COLLECTION", "ID")
)`,
    );
  });

  it('sharedCatalogHdbtable reuses the catalog column list', () => {
    const create = createCatalogTableSql('RAG_COLLECTIONS');
    const columns = create.slice(create.indexOf('(') + 1);
    assert.equal(
      sharedCatalogHdbtable('RAG_COLLECTIONS'),
      `COLUMN TABLE "RAG_COLLECTIONS" (${columns}`,
    );
  });

  it('sharedLayoutSql is catalog then documents, each prefixed CREATE', () => {
    assert.equal(
      sharedLayoutSql({ dimension: 1536 }),
      `CREATE ${sharedCatalogHdbtable('RAG_COLLECTIONS')};\nCREATE ${sharedDocumentsHdbtable('RAG_DOCUMENTS', 1536)};`,
    );
  });

  it('rejects an invalid table name', () => {
    assert.throws(
      () => sharedDocumentsHdbtable('a-b', 3),
      (e: { code?: string }) => e.code === 'INVALID_COLLECTION_NAME',
    );
    assert.throws(
      () => sharedLayoutSql({ catalogTable: 'a-b', dimension: 3 }),
      (e: { code?: string }) => e.code === 'INVALID_COLLECTION_NAME',
    );
  });

  it('shipped ddl files match the generators', () => {
    const expected: Record<string, string> = {
      'RAG_DOCUMENTS.hdbtable': sharedDocumentsHdbtable(
        SHARED_DOCUMENTS_TABLE,
        SHIPPED_DIMENSION,
      ),
      'RAG_COLLECTIONS.hdbtable': sharedCatalogHdbtable(SHARED_CATALOG_TABLE),
      'shared-layout.sql': sharedLayoutSql({ dimension: SHIPPED_DIMENSION }),
    };
    const files = readdirSync(DDL_DIR).filter((f) => f !== '.hdiconfig');
    assert.deepEqual(files.sort(), Object.keys(expected).sort());
    for (const f of files) {
      assert.equal(readFileSync(join(DDL_DIR, f), 'utf8'), `${expected[f]}\n`);
    }
  });

  it('.hdiconfig maps hdbtable to the table plugin', () => {
    const cfg = JSON.parse(readFileSync(join(DDL_DIR, '.hdiconfig'), 'utf8'));
    assert.equal(
      cfg.file_suffixes.hdbtable.plugin_name,
      'com.sap.hana.di.table',
    );
  });
});
