import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveEnvVars } from '../config.js';

describe('resolveEnvVars', () => {
  it('substitutes a plain ${VAR}', () => {
    const env = { MY_VAR: 'hello' } as NodeJS.ProcessEnv;
    assert.equal(resolveEnvVars('${MY_VAR}', env), 'hello');
  });

  it('substitutes ${VAR:-default} when var is set', () => {
    const env = { MY_VAR: 'value' } as NodeJS.ProcessEnv;
    assert.equal(resolveEnvVars('${MY_VAR:-fallback}', env), 'value');
  });

  it('uses fallback from ${VAR:-default} when env var is unset', () => {
    const env = {} as NodeJS.ProcessEnv;
    assert.equal(resolveEnvVars('${UNSET_VAR:-fallback}', env), 'fallback');
  });

  it('resolves object values at top level', () => {
    const env = { HOST: 'localhost', PORT: '4004' } as NodeJS.ProcessEnv;
    const out = resolveEnvVars({ host: '${HOST}', port: '${PORT}' }, env);
    assert.deepEqual(out, { host: 'localhost', port: '4004' });
  });

  it('resolves deeply nested object → array → object', () => {
    const env = { A: 'x' } as NodeJS.ProcessEnv;
    const out = resolveEnvVars(
      { list: [{ k: '${A}' }, { k: '${B:-fallback}' }] },
      env,
    );
    assert.deepEqual(out, { list: [{ k: 'x' }, { k: 'fallback' }] });
  });

  it('resolves each object in an array of objects carrying ${VAR:-default}', () => {
    const env = { KEY1: 'alpha' } as NodeJS.ProcessEnv;
    const input = [
      { name: '${KEY1}', url: '${URL:-http://default}' },
      { name: '${KEY2:-beta}', url: '${URL2:-http://other}' },
    ];
    const out = resolveEnvVars(input, env);
    assert.deepEqual(out, [
      { name: 'alpha', url: 'http://default' },
      { name: 'beta', url: 'http://other' },
    ]);
  });

  it('returns non-string primitives unchanged', () => {
    const env = {} as NodeJS.ProcessEnv;
    assert.equal(resolveEnvVars(42, env), 42);
    assert.equal(resolveEnvVars(true, env), true);
    assert.equal(resolveEnvVars(null, env), null);
  });
});
