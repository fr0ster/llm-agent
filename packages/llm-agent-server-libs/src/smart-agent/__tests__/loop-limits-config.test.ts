import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  ConfigWatcher,
  SmartAgent,
  type SmartAgentConfig,
} from '@mcp-abap-adt/llm-agent-libs';
import { makeDefaultDeps } from '@mcp-abap-adt/llm-agent-libs/testing';
import { parse, stringify } from 'yaml';
import { ConfigValidationError, resolveSmartServerConfig } from '../config.js';
import { ConfigReloadWatcher } from '../config-reload-watcher.js';
import { resolveAgentSection } from '../resolve-config-sections.js';
import { loadYamlConfig, YAML_TEMPLATE } from '../yaml-loader.js';

test('omitted YAML tool-loop limits are unlimited', () => {
  for (const yaml of [
    {},
    { agent: {} },
    { agent: { maxIterations: null, maxToolCalls: null } },
  ]) {
    const config = resolveAgentSection(yaml, {});
    assert.equal(config.maxIterations, undefined);
    assert.equal(config.maxToolCalls, undefined);
  }
});

test('the generated YAML template leaves tool-loop limits off', () => {
  const config = resolveAgentSection(parse(YAML_TEMPLATE), {});
  assert.equal(config.maxIterations, undefined);
  assert.equal(config.maxToolCalls, undefined);
});

test('explicit positive YAML tool-loop limits retain their values', () => {
  for (const max of [1, 10, 30]) {
    const config = resolveAgentSection(
      { agent: { maxIterations: max, maxToolCalls: max } },
      {},
    );
    assert.equal(config.maxIterations, max);
    assert.equal(config.maxToolCalls, max);
  }
});

test('invalid YAML loop limits fail validation with the field name', () => {
  for (const field of ['maxIterations', 'maxToolCalls'] as const) {
    for (const value of [
      ...(field === 'maxIterations' ? [0, '0'] : []),
      -1,
      1.5,
      Infinity,
      NaN,
      'abc',
      '',
      false,
    ]) {
      assert.throws(
        () =>
          resolveSmartServerConfig(
            {},
            {
              llm: { provider: 'ollama', model: 'test' },
              agent: { [field]: value },
            },
            {},
          ),
        (error: Error) =>
          error instanceof ConfigValidationError &&
          new RegExp(`agent\\.${field}: must be a .*integer`).test(
            error.message,
          ),
      );
    }
  }
});

test('YAML preserves zero tool-call limits', () => {
  for (const value of [0, '0']) {
    const config = resolveAgentSection({ agent: { maxToolCalls: value } }, {});
    assert.equal(config.maxToolCalls, 0);
  }
});

test('both YAML loop limits accept integer environment substitutions', () => {
  const config = resolveAgentSection(
    { agent: { maxIterations: '12', maxToolCalls: '12' } },
    {},
  );
  assert.equal(config.maxIterations, 12);
  assert.equal(config.maxToolCalls, 12);
});

test('YAML reload matches startup and updates runtime and mirrored limits atomically', (t) => {
  // Exercise the real file parser and reload handlers without filesystem timers.
  t.mock.method(ConfigWatcher.prototype, 'start', () => {});
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-limits-reload-'));
  const filePath = path.join(dir, 'config.yaml');
  try {
    for (const field of ['maxIterations', 'maxToolCalls'] as const) {
      for (const value of [undefined, null, '12', 0, '0', -1, 1.5, 'abc']) {
        const limits =
          value === '12'
            ? { maxIterations: value, maxToolCalls: value }
            : { [field]: value };
        const yaml = { agent: { ...limits, ragQueryK: 99 } };
        fs.writeFileSync(filePath, stringify(yaml), 'utf8');
        const { deps } = makeDefaultDeps();
        let mirrored: Pick<
          SmartAgentConfig,
          'maxIterations' | 'maxToolCalls' | 'ragQueryK'
        > = {
          maxIterations: 2,
          maxToolCalls: 2,
          ragQueryK: 4,
        };
        const agent = new SmartAgent(deps, mirrored);
        const errors: string[] = [];
        let applied = 0;
        let drained = 0;
        let invalidated = 0;
        const watcher = new ConfigReloadWatcher({
          configFile: filePath,
          log: (event) => {
            if (event.event === 'config_reload_error')
              errors.push(String(event.error));
          },
          applyAgentUpdate: (update) => {
            agent.applyConfigUpdate(update);
            applied++;
          },
          mirrorCfg: (patch) => {
            assert.ok('maxIterations' in patch);
            assert.ok('maxToolCalls' in patch);
            mirrored = { ...mirrored, ...patch };
          },
          drainWorkers: async () => {
            drained++;
          },
          invalidateSessions: async () => {
            invalidated++;
          },
          ragStores: {},
        });
        watcher.start();
        try {
          // biome-ignore lint/complexity/useLiteralKeys: Access the private reload path without changing its visibility.
          watcher['watcher']['_reload']();
          if (
            value == null ||
            value === '12' ||
            (field === 'maxToolCalls' && (value === 0 || value === '0'))
          ) {
            const startup = resolveAgentSection(yaml, {});
            const runtime = agent.getAgentConfig();
            assert.equal(
              startup[field],
              value == null ? undefined : Number(value),
            );
            for (const limit of ['maxIterations', 'maxToolCalls'] as const) {
              assert.equal(runtime[limit], startup[limit]);
              assert.equal(mirrored[limit], startup[limit]);
            }
            assert.equal(runtime.ragQueryK, 99);
            assert.equal(applied, 1);
            assert.equal(drained, 1);
            assert.equal(invalidated, 1);
            assert.deepEqual(errors, []);
          } else {
            assert.throws(
              () => resolveAgentSection(yaml, {}),
              ConfigValidationError,
            );
            assert.equal(errors.length, 1);
            assert.match(
              errors[0],
              new RegExp(`agent\\.${field}: must be a .*integer`),
            );
            assert.equal(applied, 0);
            assert.equal(drained, 0);
            assert.equal(invalidated, 0);
            assert.deepEqual(mirrored, {
              maxIterations: 2,
              maxToolCalls: 2,
              ragQueryK: 4,
            });
            assert.equal(agent.getAgentConfig().maxIterations, 2);
            assert.equal(agent.getAgentConfig().maxToolCalls, 2);
            assert.equal(agent.getAgentConfig().ragQueryK, 4);
          }
        } finally {
          watcher.stop();
        }
      }
    }
  } finally {
    fs.rmSync(filePath, { force: true });
    fs.rmdirSync(dir);
  }
});

test('YAML reload uses startup env substitution before normalizing both limits', (t) => {
  t.mock.method(ConfigWatcher.prototype, 'start', () => {});
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-limits-env-'));
  const filePath = path.join(dir, 'config.yaml');
  const envName = 'LLM_AGENT_LOOP_LIMIT_TEST';
  const original = process.env[envName];
  try {
    for (const field of ['maxIterations', 'maxToolCalls'] as const) {
      for (const envValue of [undefined, '', '7', '0', 'invalid']) {
        if (envValue === undefined) delete process.env[envName];
        else process.env[envName] = envValue;
        const placeholder = `\${${envName}:-12}`;
        fs.writeFileSync(
          filePath,
          stringify({
            agent: {
              maxIterations: 2,
              maxToolCalls: 2,
              [field]: placeholder,
            },
          }),
          'utf8',
        );
        const watcher = new ConfigWatcher(filePath);
        const reloads: { maxIterations?: number; maxToolCalls?: number }[] = [];
        const errors: Error[] = [];
        watcher.on(
          'reload',
          (config: { maxIterations?: number; maxToolCalls?: number }) =>
            reloads.push(config),
        );
        watcher.on('error', (error: Error) => errors.push(error));
        // biome-ignore lint/complexity/useLiteralKeys: Exercise reload without filesystem timers.
        watcher['_reload']();
        if (
          (envValue === '0' && field === 'maxIterations') ||
          envValue === 'invalid'
        ) {
          assert.throws(
            () => resolveAgentSection(loadYamlConfig(filePath), {}),
            new RegExp(field),
          );
          assert.equal(reloads.length, 0);
          assert.equal(errors.length, 1);
          assert.match(errors[0].message, new RegExp(`${field}.*integer`));
        } else {
          const startup = resolveAgentSection(loadYamlConfig(filePath), {});
          assert.deepEqual(errors, []);
          assert.equal(reloads.length, 1);
          assert.equal(
            reloads[0][field],
            envValue === '7' || envValue === '0' ? Number(envValue) : 12,
          );
          for (const limit of ['maxIterations', 'maxToolCalls'] as const) {
            assert.equal(reloads[0][limit], startup[limit]);
          }
        }
        watcher.stop();
      }
    }
  } finally {
    if (original === undefined) delete process.env[envName];
    else process.env[envName] = original;
    fs.rmSync(filePath, { force: true });
    fs.rmdirSync(dir);
  }
});
