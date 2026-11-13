import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  accessForeignKeyHdbconstraint,
  accessForeignKeys,
  accessTables,
} from '../access-ddl.js';
import { createCatalogTableSql } from '../catalog.js';
import { migrateHanaVectorRagAccess } from '../migrate-access.js';
import {
  SHARED_CATALOG_TABLE,
  SHARED_DOCUMENTS_TABLE,
  SHIPPED_DIMENSION,
  sharedCatalogHdbtable,
  sharedDocumentsHdbtable,
  sharedLayoutSql,
} from '../shared-ddl.js';
import { accessFixture } from './access-fixture.js';

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

  it('honours custom table names and dimension', () => {
    const documents = sharedDocumentsHdbtable('MY_DOCS', 3);
    assert.ok(documents.startsWith('COLUMN TABLE "MY_DOCS" ('));
    assert.ok(documents.includes('"VECTOR" REAL_VECTOR(3)'));
    assert.ok(
      sharedCatalogHdbtable('MY_CAT').startsWith('COLUMN TABLE "MY_CAT" ('),
    );
    const sql = sharedLayoutSql({
      documentsTable: 'MY_DOCS',
      catalogTable: 'MY_CAT',
      dimension: 3,
    });
    assert.equal(
      sql,
      `CREATE ${sharedCatalogHdbtable('MY_CAT')};
CREATE ${documents};`,
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
    for (const table of accessTables) {
      expected[`${table.name}.hdbtable`] =
        `COLUMN TABLE "${table.name}" (${table.definition})`;
    }
    for (const key of accessForeignKeys) {
      expected[`${key.name}.hdbconstraint`] =
        accessForeignKeyHdbconstraint(key);
    }
    const files = readdirSync(DDL_DIR).filter((f) => f !== '.hdiconfig');
    assert.deepEqual(files.sort(), Object.keys(expected).sort());
    for (const f of files) {
      assert.equal(readFileSync(join(DDL_DIR, f), 'utf8'), `${expected[f]}\n`);
    }
  });

  it('.hdiconfig maps both HDI artifact suffixes', () => {
    const cfg = JSON.parse(readFileSync(join(DDL_DIR, '.hdiconfig'), 'utf8'));
    assert.equal(
      cfg.file_suffixes.hdbconstraint.plugin_name,
      'com.sap.hana.di.constraint',
    );
    assert.equal(
      cfg.file_suffixes.hdbtable.plugin_name,
      'com.sap.hana.di.table',
    );
  });
  it('HDI tables have no references and each foreign key has one artifact', () => {
    const files = readdirSync(DDL_DIR);
    const constraints = files.filter((file) => file.endsWith('.hdbconstraint'));
    assert.equal(files.filter((file) => file.endsWith('.hdbtable')).length, 6);
    assert.deepEqual(constraints.sort(), [
      'rag_collection_roles_role_fk.hdbconstraint',
      'rag_role_assignments_role_fk.hdbconstraint',
    ]);
    for (const file of files.filter((file) => file.endsWith('.hdbtable'))) {
      assert.doesNotMatch(
        readFileSync(join(DDL_DIR, file), 'utf8'),
        /REFERENCES/i,
      );
    }
    for (const table of ['rag_collection_roles', 'rag_role_assignments']) {
      assert.equal(
        readFileSync(join(DDL_DIR, `${table}_role_fk.hdbconstraint`), 'utf8'),
        `CONSTRAINT "${table}_role_fk" ON "${table}" FOREIGN KEY ("ROLE_ID") REFERENCES "rag_roles" ("ROLE_ID")\n`,
      );
    }
  });

  it('runtime migration and HDI describe identical access columns, keys and foreign keys', async () => {
    const { db, provider } = accessFixture();
    assert.ok((await migrateHanaVectorRagAccess(provider)).ok);
    for (const table of accessTables) {
      let definition = readFileSync(
        join(DDL_DIR, `${table.name}.hdbtable`),
        'utf8',
      )
        .trim()
        .slice(`COLUMN TABLE "${table.name}" (`.length, -1);
      for (const key of accessForeignKeys.filter(
        (key) => key.table === table.name,
      )) {
        const constraint = readFileSync(
          join(DDL_DIR, `${key.name}.hdbconstraint`),
          'utf8',
        ).trim();
        definition += `, ${constraint.replace(` ON "${table.name}"`, '')}`;
      }
      assert.equal(
        db.statements.filter((sql) =>
          sql.startsWith(`CREATE TABLE "${table.name}" (`),
        ).length,
        1,
      );
      assert.ok(
        db.statements.includes(`CREATE TABLE "${table.name}" (${definition})`),
      );
    }
  });
});
