// Writes the shipped shared-layout DDL into ddl/. Run: npm run ddl
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHIPPED_DIMENSION, sharedLayoutSql } from '../src/shared-ddl.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'ddl');
mkdirSync(dir, { recursive: true });
writeFileSync(
  join(dir, 'shared-layout.sql'),
  `${sharedLayoutSql({ dimension: SHIPPED_DIMENSION })}\n`,
);
