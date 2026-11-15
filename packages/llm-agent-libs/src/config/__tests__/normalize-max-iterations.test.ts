import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SmartAgent } from '../../agent.js';
import { makeDefaultDeps } from '../../testing/index.js';
import { normalizeMaxIterations } from '../normalize-max-iterations.js';

test('iteration limit boundaries normalize unset values and reject invalid values', () => {
  assert.equal(normalizeMaxIterations(undefined), undefined);
  assert.equal(normalizeMaxIterations(null), undefined);
  assert.equal(normalizeMaxIterations(12), 12);
  for (const value of [0, -1, 1.5, Infinity, NaN, '2', false, {}]) {
    assert.throws(() => normalizeMaxIterations(value), /positive integer/);
  }
});

test('config patches reset the limit and reject invalid values atomically', () => {
  const { deps } = makeDefaultDeps();
  const agent = new SmartAgent(deps, { maxIterations: 2, ragQueryK: 4 });
  agent.applyConfigUpdate({ showReasoning: true });
  assert.equal(agent.getAgentConfig().maxIterations, 2);
  agent.applyConfigUpdate({ maxIterations: null });
  assert.equal(agent.getAgentConfig().maxIterations, undefined);
  assert.equal(
    JSON.stringify(agent.getAgentConfig()).includes('maxIterations'),
    false,
  );
  for (const maxIterations of [0, -1, 1.5, Infinity, NaN]) {
    assert.throws(
      () => agent.applyConfigUpdate({ maxIterations, ragQueryK: 99 }),
      /positive integer/,
    );
    assert.equal(agent.getAgentConfig().ragQueryK, 4);
    assert.equal(agent.getAgentConfig().maxIterations, undefined);
  }
  agent.applyConfigUpdate({ maxIterations: 3 });
  assert.equal(agent.getAgentConfig().maxIterations, 3);
  agent.applyConfigUpdate({ maxIterations: undefined });
  assert.equal(agent.getAgentConfig().maxIterations, undefined);
});
