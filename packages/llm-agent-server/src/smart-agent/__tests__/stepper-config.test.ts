import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseStepperCoordinatorConfig } from '../config.js';

test('parses mode, mutationPolicy, knownReadOnlyTools, stepper.* with defaults', () => {
  const c = parseStepperCoordinatorConfig({
    mode: 'planned-react',
    mutationPolicy: 'trusted',
    knownReadOnlyTools: ['GetProgram', 'GetInclude'],
    stepper: {
      maxParallelSteps: 8,
      reviewer: { atDepths: [0, 1, 2] },
      maxDepth: 5,
      tokenBudget: 500000,
    },
  });
  assert.equal(c.mode, 'planned-react');
  assert.equal(c.toolSafety.mutationPolicy, 'trusted');
  assert.equal(c.toolSafety.knownReadOnlyTools.has('GetProgram'), true);
  assert.equal(c.maxParallelSteps, 8);
  assert.equal(c.reviewerAtDepths.has(0), true);
  assert.equal(c.reviewerAtDepths.has(2), true);
  assert.equal(c.reviewerAtDepths.has(3), false);
  assert.equal(c.maxDepth, 5);
  assert.equal(c.tokenBudget, 500000);
});

test('defaults: mode=planned-react, mutationPolicy=confirm, reviewer atDepths=[0,1], maxParallelSteps=4', () => {
  const c = parseStepperCoordinatorConfig({});
  assert.equal(c.mode, 'planned-react');
  assert.equal(c.toolSafety.mutationPolicy, 'confirm');
  assert.equal(c.toolSafety.knownReadOnlyTools.size, 0);
  assert.equal(c.reviewerAtDepths.has(0), true);
  assert.equal(c.reviewerAtDepths.has(1), true);
  assert.equal(c.reviewerAtDepths.has(2), false);
  assert.equal(c.maxParallelSteps, 4);
});

test("reviewer atDepths 'all' yields a predicate that accepts any depth", () => {
  const c = parseStepperCoordinatorConfig({
    stepper: { reviewer: { atDepths: 'all' } },
  });
  assert.equal(c.reviewerAtDepths.has(0), true);
  assert.equal(c.reviewerAtDepths.has(99), true);
});

test('invalid mode throws', () => {
  assert.throws(
    () => parseStepperCoordinatorConfig({ mode: 'bogus' }),
    /unknown coordinator\.mode/i,
  );
});
