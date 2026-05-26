import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertCoordinatorConfigShape } from '../config.js';

describe('coordinator config shape (DAG vs linear)', () => {
  it('accepts a DAG coordinator (planner present, activation allowed)', () => {
    assert.doesNotThrow(() =>
      assertCoordinatorConfigShape({
        planner: { type: 'llm' },
        activation: 'auto',
      }),
    );
  });
  it('accepts a linear coordinator (planning present)', () => {
    assert.doesNotThrow(() =>
      assertCoordinatorConfigShape({
        planning: 'one-shot',
        dispatch: 'hybrid',
      }),
    );
  });
  it('rejects mixing planner with linear-only fields', () => {
    assert.throws(
      () =>
        assertCoordinatorConfigShape({ planner: { type: 'llm' }, maxSteps: 5 }),
      /maxSteps/,
    );
    assert.throws(
      () =>
        assertCoordinatorConfigShape({
          planner: { type: 'llm' },
          planning: 'one-shot',
        }),
      /planning/,
    );
    assert.throws(
      () =>
        assertCoordinatorConfigShape({
          planner: { type: 'llm' },
          plannerLlm: 'main',
        }),
      /plannerLlm/,
    );
  });
  it('rejects DAG-only fields in a linear coordinator', () => {
    assert.throws(
      () =>
        assertCoordinatorConfigShape({
          planning: 'one-shot',
          interpreter: { type: 'dag' },
        }),
      /interpreter/,
    );
  });
});
