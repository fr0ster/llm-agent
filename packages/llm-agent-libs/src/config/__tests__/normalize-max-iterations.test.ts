import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SmartAgent } from '../../agent.js';
import { makeDefaultDeps } from '../../testing/index.js';
import {
  normalizeLoopLimit,
  normalizeMaxIterations,
} from '../normalize-max-iterations.js';

test('loop limits share integer parsing with field-specific minimums', () => {
  for (const field of ['maxIterations', 'maxToolCalls'] as const) {
    for (const value of [undefined, null, Infinity]) {
      assert.equal(normalizeLoopLimit(value, field), undefined);
    }
    for (const value of [12, '12', ' 12 ', '0012']) {
      assert.equal(normalizeLoopLimit(value, field), 12);
    }
    for (const value of [
      ...(field === 'maxIterations' ? [0, '0'] : []),
      -1,
      1.5,
      -Infinity,
      'Infinity',
      NaN,
      '-1',
      '1.5',
      'abc',
      '',
      ' ',
      false,
      {},
      [],
    ]) {
      assert.throws(
        () => normalizeLoopLimit(value, field),
        new RegExp(`agent\\.${field}: must be a .*integer`),
      );
    }
  }
});

test('zero tool-call limits are preserved, including numeric strings', () => {
  for (const value of [0, '0', ' 0 ', '000']) {
    assert.equal(normalizeLoopLimit(value, 'maxToolCalls'), 0);
  }
});

test('iteration limit boundaries normalize unset values and reject invalid values', () => {
  assert.equal(normalizeMaxIterations(undefined), undefined);
  assert.equal(normalizeMaxIterations(null), undefined);
  assert.equal(normalizeMaxIterations(Infinity), undefined);
  assert.equal(normalizeMaxIterations(12), 12);
  assert.equal(normalizeMaxIterations('12'), 12);
  for (const value of [
    0,
    -1,
    1.5,
    -Infinity,
    NaN,
    'Infinity',
    'abc',
    false,
    {},
  ]) {
    assert.throws(() => normalizeMaxIterations(value), /positive integer/);
  }
});

for (const field of ['maxIterations', 'maxToolCalls'] as const) {
  test(`config patches normalize ${field} and reject invalid values atomically`, () => {
    const { deps } = makeDefaultDeps();
    const agent = new SmartAgent(deps, { [field]: 2, ragQueryK: 4 });
    agent.applyConfigUpdate({ showReasoning: true });
    assert.equal(agent.getAgentConfig()[field], 2);
    agent.applyConfigUpdate({ [field]: null });
    assert.equal(agent.getAgentConfig()[field], undefined);
    assert.equal(JSON.stringify(agent.getAgentConfig()).includes(field), false);
    agent.applyConfigUpdate({ [field]: 2 });
    agent.applyConfigUpdate({ [field]: Infinity });
    assert.equal(agent.getAgentConfig()[field], undefined);
    assert.equal(JSON.stringify(agent.getAgentConfig()).includes(field), false);
    for (const value of [
      ...(field === 'maxIterations' ? [0, '0'] : []),
      -1,
      1.5,
      -Infinity,
      'Infinity',
      NaN,
      'abc',
      false,
      {},
      [],
    ]) {
      assert.throws(
        () => agent.applyConfigUpdate({ [field]: value, ragQueryK: 99 }),
        new RegExp(`${field}.*integer`),
      );
      assert.equal(agent.getAgentConfig().ragQueryK, 4);
      assert.equal(agent.getAgentConfig()[field], undefined);
    }
    for (const value of [3, '3']) {
      agent.applyConfigUpdate({ [field]: value });
      assert.equal(agent.getAgentConfig()[field], 3);
    }
    if (field === 'maxToolCalls') {
      for (const value of [0, '0']) {
        agent.applyConfigUpdate({ [field]: value });
        assert.equal(agent.getAgentConfig()[field], 0);
        assert.equal(agent.maxToolCalls, 0);
      }
    }
    agent.applyConfigUpdate({ [field]: undefined });
    assert.equal(agent.getAgentConfig()[field], undefined);
  });
  test(`direct construction normalizes ${field}`, () => {
    const { deps } = makeDefaultDeps();
    for (const value of [
      undefined,
      null,
      Infinity,
      12,
      '12',
      ...(field === 'maxToolCalls' ? [0, '0'] : []),
    ]) {
      const agent = new SmartAgent(deps, { [field]: value });
      assert.equal(
        agent.getAgentConfig()[field],
        value == null || value === Infinity ? undefined : Number(value),
      );
    }
    for (const value of [
      ...(field === 'maxIterations' ? [0, '0'] : []),
      -1,
      1.5,
      -Infinity,
      'Infinity',
      NaN,
      'abc',
      false,
      {},
      [],
    ]) {
      assert.throws(
        () => new SmartAgent(deps, { [field]: value }),
        new RegExp(`${field}.*integer`),
      );
    }
  });
}

test('an invalid second limit rejects the whole config patch', () => {
  const { deps } = makeDefaultDeps();
  const agent = new SmartAgent(deps, { maxIterations: 2, maxToolCalls: 3 });
  assert.throws(
    () => agent.applyConfigUpdate({ maxIterations: 1, maxToolCalls: -1 }),
    /maxToolCalls/,
  );
  assert.equal(agent.getAgentConfig().maxIterations, 2);
  assert.equal(agent.maxToolCalls, 3);
});
