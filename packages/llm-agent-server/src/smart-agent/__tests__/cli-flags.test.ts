import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

describe('cli env files fail loud (spec §10.5.9 V8)', () => {
  /**
   * Runs the CLI in a fresh temp dir: should it go on past its env files, it
   * writes a config template into its cwd — never into the repository. tsx is
   * resolved from this package: that cwd has no node_modules.
   */
  function runCliInTempDir(args: string[]) {
    const cwd = mkdtempSync(path.join(tmpdir(), 'cli-v8-'));
    try {
      return spawnSync(
        'node',
        ['--import', import.meta.resolve('tsx/esm'), CLI, ...args],
        { encoding: 'utf8', cwd },
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }

  it('--env-path naming a file that cannot be read → exit 1 with the path and the reason', () => {
    const r = runCliInTempDir(['--env-path', '/no/such/file']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /cannot read env file \/no\/such\/file: .*ENOENT/);
  });

  it('--env with a secrets-dir that cannot be read → exit 1 with the path and the reason', () => {
    const r = runCliInTempDir(['--env', '--secrets-dir', '/no/such/dir']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /cannot read secrets-dir \/no\/such\/dir: .*ENOENT/);
  });

  it('--env with a *.env entry that cannot be read → exit 1 naming it', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cli-v8-secrets-'));
    try {
      // A directory named a.env: reading it fails with EISDIR.
      mkdirSync(path.join(dir, 'a.env'));
      const r = runCliInTempDir(['--env', '--secrets-dir', dir]);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /cannot read env file .*a\.env/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an absent implicit .env stays ignored (absent by design)', () => {
    // Neither flag, a cwd without .env, and a config path that cannot be
    // written: the process stops at its config, naming it — not at an env file.
    const r = runCliInTempDir(['--config', '/no/such/config.yaml']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /\/no\/such\/config\.yaml/);
    assert.doesNotMatch(r.stderr, /env file/);
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

describe('cli composition root', () => {
  it('fails at startup naming the default credentialRef when nothing supplies it', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cli-root-'));
    const cfg = path.join(dir, 'smart-server.yaml');
    writeFileSync(
      cfg,
      [
        'port: 0',
        'llm:',
        '  main: { provider: openai, model: gpt-4o-mini }',
      ].join('\n'),
    );
    const env = { ...process.env };
    delete env.LLM_API_KEY;
    const r = spawnSync('node', ['--import', 'tsx/esm', CLI, '--config', cfg], {
      encoding: 'utf8',
      env,
      timeout: 60_000,
    });
    assert.notEqual(r.status, 0);
    assert.match(
      r.stderr,
      /credentialRef 'LLM' must hold a api-key credential for openai, got none/,
    );
  });
});
