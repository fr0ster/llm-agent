// Writes the shipped shared-layout DDL into ddl/. Run: npm run ddl
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  accessForeignKeyHdbconstraint,
  accessForeignKeys,
  accessTables,
} from '../src/access-ddl.js';
import {
  SHARED_CATALOG_TABLE,
  SHARED_DOCUMENTS_TABLE,
  SHIPPED_DIMENSION,
  sharedCatalogHdbtable,
  sharedDocumentsHdbtable,
  sharedLayoutSql,
} from '../src/shared-ddl.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'ddl');
mkdirSync(dir, { recursive: true });

const files: Record<string, string> = {
  [`${SHARED_DOCUMENTS_TABLE}.hdbtable`]: sharedDocumentsHdbtable(
    SHARED_DOCUMENTS_TABLE,
    SHIPPED_DIMENSION,
  ),
  [`${SHARED_CATALOG_TABLE}.hdbtable`]:
    sharedCatalogHdbtable(SHARED_CATALOG_TABLE),
  'shared-layout.sql': sharedLayoutSql({ dimension: SHIPPED_DIMENSION }),
};
for (const table of accessTables) {
  files[`${table.name}.hdbtable`] =
    `COLUMN TABLE "${table.name}" (${table.definition})`;
}
for (const key of accessForeignKeys) {
  files[`${key.name}.hdbconstraint`] = accessForeignKeyHdbconstraint(key);
}
for (const [name, body] of Object.entries(files)) {
  writeFileSync(join(dir, name), `${body}\n`);
}
writeFileSync(
  join(dir, '.hdiconfig'),
  `${JSON.stringify({ file_suffixes: { hdbtable: { plugin_name: 'com.sap.hana.di.table' }, hdbconstraint: { plugin_name: 'com.sap.hana.di.constraint' } } }, null, 2)}\n`,
);
