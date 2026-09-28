import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const root = path.resolve(import.meta.dirname, '../..');
const readJson = (p: string) =>
  JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));

test('a global install of the server puts only llm-agent on the PATH', () => {
  const pkg = readJson('packages/llm-agent-server/package.json');
  assert.deepEqual(Object.keys(pkg.bin), ['llm-agent']);
  for (const target of Object.values(pkg.bin) as string[]) {
    assert.ok(
      fs.existsSync(path.join(root, 'packages/llm-agent-server', target)),
      `bin target ${target} exists`,
    );
  }
});

test('the repository tools are not in the published tarball', () => {
  const { files } = readJson('packages/llm-agent-server/package.json');
  for (const dir of ['scripts', 'tools']) {
    assert.ok(!files.includes(dir), `"${dir}" is not published`);
  }
});

test('the repository tools run from the repo root', () => {
  const { scripts } = readJson('package.json');
  for (const name of ['models:check', 'claude:via-agent']) {
    const target = String(scripts[name]).split(' ').at(-1) as string;
    assert.ok(
      fs.existsSync(path.join(root, target)),
      `${name} → ${target} exists`,
    );
  }
});
