import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parse } from 'yaml';
import { ConfigValidationError, resolveSmartServerConfig } from '../config.js';
import { resolveAgentSection } from '../resolve-config-sections.js';
import { YAML_TEMPLATE } from '../yaml-loader.js';

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

test('invalid YAML iteration limits fail validation', () => {
  for (const maxIterations of [0, -1, 1.5, Infinity, NaN, '', false]) {
    assert.throws(
      () =>
        resolveSmartServerConfig(
          {},
          {
            llm: { provider: 'ollama', model: 'test' },
            agent: { maxIterations },
          },
          {},
        ),
      ConfigValidationError,
    );
  }
});

test('YAML iteration limits accept integer environment substitutions', () => {
  assert.equal(
    resolveAgentSection({ agent: { maxIterations: '12' } }, {}).maxIterations,
    12,
  );
});
