import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

function runCliEnv(args: string[], extraEnv: Record<string, string>) {
  return spawnSync('node', ['--import', 'tsx/esm', CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
  });
}

describe('cli env loading', () => {
  it('--env-path loads a specific file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cli-env-'));
    writeFileSync(path.join(dir, 'a.env'), 'FOO=from_envpath\n');
    const r = runCliEnv(['--env-path', path.join(dir, 'a.env')], {
      __CLI_PRINT_ENV: 'FOO',
    });
    assert.match(r.stdout, /FOO=from_envpath/);
  });

  it('--env scans secrets-dir for *.env (alphabetical, first wins)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cli-env-'));
    writeFileSync(path.join(dir, '1-a.env'), 'BAR=first\n');
    writeFileSync(path.join(dir, '2-b.env'), 'BAR=second\n');
    const r = runCliEnv(['--secrets-dir', dir, '--env'], {
      __CLI_PRINT_ENV: 'BAR',
    });
    assert.match(r.stdout, /BAR=first/);
  });

  it('pre-existing process.env wins over file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cli-env-'));
    writeFileSync(path.join(dir, 'a.env'), 'BAZ=from_file\n');
    const r = runCliEnv(['--env-path', path.join(dir, 'a.env')], {
      __CLI_PRINT_ENV: 'BAZ',
      BAZ: 'from_shell',
    });
    assert.match(r.stdout, /BAZ=from_shell/);
  });
});

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
