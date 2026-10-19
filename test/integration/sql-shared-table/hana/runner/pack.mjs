// Packs the two workspaces into ./vendor under stable names. Run
// `npm run build` at the repo root first.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../../..');
const vendor = join(here, 'vendor');
mkdirSync(vendor, { recursive: true });
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

for (const ws of ['llm-agent', 'hana-vector-rag']) {
  const out = execFileSync(
    npm,
    ['pack', `--workspace=@mcp-abap-adt/${ws}`, '--pack-destination', vendor],
    { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' },
  );
  const produced = out.trim().split(/\r?\n/).pop();
  const stable = `mcp-abap-adt-${ws}.tgz`;
  if (!readdirSync(vendor).includes(produced))
    throw new Error(`npm pack did not produce ${produced}`);
  renameSync(join(vendor, produced), join(vendor, stable));
  console.log(`packed ${ws} -> vendor/${stable}`);
}
