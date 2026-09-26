import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('composition import side effects', () => {
  // @sap-ai-sdk/orchestration installs process 'uncaughtException' listeners at
  // import time; with them installed, a process survives an uncaught exception and
  // prints it to stdout. Only a deployment that selects 'sap-ai-sdk' may load it.
  // A fresh process, so no other test's imports pollute the count.
  it('importing composition/index installs no uncaughtException listener', () => {
    const script = [
      "const before = process.listeners('uncaughtException').length;",
      "await import('./src/composition/index.ts');",
      "process.stdout.write(JSON.stringify({ before, after: process.listeners('uncaughtException').length }));",
    ].join('\n');
    const run = spawnSync(
      process.execPath,
      ['--import', 'tsx/esm', '--input-type=module', '-e', script],
      { cwd: pkgDir, encoding: 'utf8' },
    );
    assert.equal(run.status, 0, run.stderr);
    const { before, after } = JSON.parse(run.stdout) as {
      before: number;
      after: number;
    };
    assert.equal(after, before);
  });
});
