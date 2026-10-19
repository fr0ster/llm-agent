// Copies the shipped DDL of @mcp-abap-adt/hana-vector-rag into ./src so the
// deployer never drifts from the package. Run before `cf push`.
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ddl = resolve(here, '../../../../../packages/hana-vector-rag/ddl');
const dest = join(here, 'src');
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
for (const f of [
  '.hdiconfig',
  'RAG_DOCUMENTS.hdbtable',
  'RAG_COLLECTIONS.hdbtable',
])
  cpSync(join(ddl, f), join(dest, f));
console.log(`copied HDI sources from ${ddl} to ${dest}`);
