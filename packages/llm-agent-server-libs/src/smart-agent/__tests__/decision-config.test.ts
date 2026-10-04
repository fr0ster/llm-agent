import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import { resolveSmartServerConfig } from '../config.js';
import { loadYamlConfig } from '../yaml-loader.js';

const LLM = 'llm:\n  provider: openai\n  model: gpt-4o\n';

function resolve(text: string) {
  return resolveSmartServerConfig(
    {},
    parse(LLM + text),
    {},
    {
      skipProviderRuntimeChecks: true,
    },
  );
}

describe('decision: resolution', () => {
  it('absent sections stay absent', () => {
    const cfg = resolve('');
    assert.equal('decision' in cfg, false);
  });

  it('copies named fields only; absent optionals stay absent', () => {
    const cfg = resolve('decision:\n  provider: typesafe\n');
    assert.deepEqual(cfg.decision, { provider: 'typesafe' });
    assert.deepEqual(Object.keys(cfg.decision ?? {}), ['provider']);
  });

  it('keeps every field, and maxRetries: 0 stays 0', () => {
    const cfg = resolve(
      [
        'decision:',
        '  provider: typesafe',
        '  model: jev-latest',
        '  credentialRef: TYPESAFE',
        '  baseUrl: https://proxy.example',
        '  timeoutMs: 5000',
        '  maxRetries: 0',
        '',
      ].join('\n'),
    );
    assert.deepEqual(cfg.decision, {
      provider: 'typesafe',
      model: 'jev-latest',
      credentialRef: 'TYPESAFE',
      baseUrl: 'https://proxy.example',
      timeoutMs: 5000,
      maxRetries: 0,
    });
  });

  it('a decision: section alone is valid', () => {
    assert.doesNotThrow(() => resolve('decision:\n  provider: typesafe\n'));
  });
});

describe('${VAR}-substituted numbers (loadYamlConfig substitutes strings)', () => {
  function fromFile(text: string, env: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), 'decision-cfg-'));
    const path = join(dir, 'smart-server.yaml');
    writeFileSync(path, LLM + text);
    try {
      return resolveSmartServerConfig({}, loadYamlConfig(path, env), env, {
        skipProviderRuntimeChecks: true,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const SECTION =
    'decision:\n  provider: typesafe\n  timeoutMs: ${DT}\n  maxRetries: ${DR}\n';

  it('"5000" and "0" are accepted and become numbers', () => {
    const cfg = fromFile(SECTION, { DT: '5000', DR: '0' });
    assert.equal(cfg.decision?.timeoutMs, 5000);
    assert.equal(cfg.decision?.maxRetries, 0);
  });

  it('an unset variable (empty string) is refused, never read as 0', () => {
    assert.throws(
      () => fromFile(SECTION, { DT: '5000' }),
      /decision\.maxRetries/,
    );
  });

  it('a non-numeric value is refused', () => {
    assert.throws(
      () => fromFile(SECTION, { DT: 'soon', DR: '1' }),
      /decision\.timeoutMs/,
    );
  });
});

describe('decision.model / decision.baseUrl through ${VAR}', () => {
  function fromFile(text: string, env: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), 'decision-cfg-'));
    const path = join(dir, 'smart-server.yaml');
    writeFileSync(path, LLM + text);
    try {
      return resolveSmartServerConfig({}, loadYamlConfig(path, env), env, {
        skipProviderRuntimeChecks: true,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('an unset ${VAR} model is refused', () => {
    assert.throws(
      () => fromFile('decision:\n  provider: typesafe\n  model: ${DM}\n', {}),
      /decision\.model: must be a non-empty string/,
    );
  });

  it('an unset ${VAR} baseUrl is refused', () => {
    assert.throws(
      () => fromFile('decision:\n  provider: typesafe\n  baseUrl: ${DB}\n', {}),
      /decision\.baseUrl: must be a non-empty string/,
    );
  });

  it('set values are accepted', () => {
    const cfg = fromFile(
      'decision:\n  provider: typesafe\n  model: ${DM}\n  baseUrl: ${DB}\n',
      { DM: 'jev-latest', DB: 'https://proxy.example' },
    );
    assert.equal(cfg.decision?.model, 'jev-latest');
    assert.equal(cfg.decision?.baseUrl, 'https://proxy.example');
  });
});

describe('decision: validation', () => {
  for (const [yaml, re] of [
    ['decision:\n  model: x\n', /decision\.provider/],
    ['decision:\n  provider: openai\n', /decision\.provider/],
    [
      'decision:\n  provider: typesafe\n  credentialRef: ""\n',
      /decision\.credentialRef/,
    ],
    [
      'decision:\n  provider: typesafe\n  apiKey: sk-x\n',
      /decision\.apiKey: secrets are no longer read/,
    ],
    [
      'decision:\n  provider: typesafe\n  model: ""\n',
      /decision\.model: must be a non-empty string/,
    ],
    [
      'decision:\n  provider: typesafe\n  baseUrl: ""\n',
      /decision\.baseUrl: must be a non-empty string/,
    ],
    [
      'decision:\n  provider: typesafe\n  timeoutMs: 0\n',
      /decision\.timeoutMs/,
    ],
    [
      'decision:\n  provider: typesafe\n  timeoutMs: 1.5\n',
      /decision\.timeoutMs/,
    ],
    [
      'decision:\n  provider: typesafe\n  maxRetries: -1\n',
      /decision\.maxRetries/,
    ],
  ] as const) {
    it(`rejects ${JSON.stringify(yaml)}`, () => {
      assert.throws(() => resolve(yaml), re);
    });
  }

  it('the apiKey refused in decision: is not copied into the config', () => {
    assert.throws(() =>
      resolve('decision:\n  provider: typesafe\n  apiKey: sk-x\n'),
    );
  });

  it('llm.apiKey still produces the same message (extraction kept behaviour)', () => {
    assert.throws(
      () =>
        resolveSmartServerConfig(
          {},
          parse('llm:\n  provider: openai\n  model: m\n  apiKey: sk\n'),
          {},
          { skipProviderRuntimeChecks: true },
        ),
      /llm\.apiKey: secrets are no longer read from configuration/,
    );
  });
});

describe('decision: empty YAML values (null) are absent, never the string "null"', () => {
  it('model: / baseUrl: left empty resolve to absent fields', () => {
    const cfg = resolve(
      'decision:\n  provider: typesafe\n  model:\n  baseUrl:\n',
    );
    assert.deepEqual(cfg.decision, { provider: 'typesafe' });
    assert.equal('model' in (cfg.decision ?? {}), false);
    assert.equal('baseUrl' in (cfg.decision ?? {}), false);
  });
});
