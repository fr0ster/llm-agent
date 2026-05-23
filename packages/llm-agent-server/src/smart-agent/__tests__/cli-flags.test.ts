import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '../cli.ts');

function runCli(args: string[]) {
  return spawnSync('node', ['--import', 'tsx/esm', CLI, ...args], {
    encoding: 'utf8',
  });
}

describe('cli strict flag parsing', () => {
  it('rejects a removed behavior flag (--llm-api-key)', () => {
    const r = runCli(['--llm-api-key', 'x']);
    assert.notEqual(r.status, 0);
    assert.match(`${r.stderr}${r.stdout}`, /unknown|unexpected|--llm-api-key/i);
  });

  it('rejects the dead --llm-only flag', () => {
    const r = runCli(['--llm-only']);
    assert.notEqual(r.status, 0);
    assert.match(`${r.stderr}${r.stdout}`, /unknown|unexpected|--llm-only/i);
  });

  it('accepts --version', () => {
    const r = runCli(['--version']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /@mcp-abap-adt\/llm-agent-server@/);
  });
});
