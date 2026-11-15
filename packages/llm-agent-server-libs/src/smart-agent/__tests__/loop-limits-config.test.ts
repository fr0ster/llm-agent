import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parse } from 'yaml';
import { resolveAgentSection } from '../resolve-config-sections.js';
import { YAML_TEMPLATE } from '../yaml-loader.js';

test('omitted YAML tool-loop limits are unlimited', () => {
  for (const yaml of [
    {},
    { agent: {} },
    { agent: { maxIterations: null, maxToolCalls: null } },
  ]) {
    const config = resolveAgentSection(yaml, {});
    assert.equal(config.maxIterations, Infinity);
    assert.equal(config.maxToolCalls, undefined);
  }
});

test('the generated YAML template leaves tool-loop limits off', () => {
  const config = resolveAgentSection(parse(YAML_TEMPLATE), {});
  assert.equal(config.maxIterations, Infinity);
  assert.equal(config.maxToolCalls, undefined);
});

test('explicit YAML tool-loop limits retain their values, including zero', () => {
  for (const max of [0, 1, 10, 30]) {
    const config = resolveAgentSection(
      { agent: { maxIterations: max, maxToolCalls: max } },
      {},
    );
    assert.equal(config.maxIterations, max);
    assert.equal(config.maxToolCalls, max);
  }
});
