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
  it('accepts a DAG coordinator without an activation field', () => {
    assert.doesNotThrow(() =>
      assertCoordinatorConfigShape({ planner: { type: 'llm' } }),
    );
  });
  it('accepts a DAG coordinator with an empty planner object (type defaults)', () => {
    assert.doesNotThrow(() => assertCoordinatorConfigShape({ planner: {} }));
  });
  it('rejects an unknown planner.type', () => {
    assert.throws(
      () => assertCoordinatorConfigShape({ planner: { type: 'bogus' } }),
      /unknown type 'bogus'/,
    );
  });
  it('accepts valid planner.plannerLlm selectors', () => {
    for (const sel of ['main', 'planner', 'helper']) {
      assert.doesNotThrow(() =>
        assertCoordinatorConfigShape({
          planner: { type: 'llm', plannerLlm: sel },
        }),
      );
    }
  });
  it('rejects an unknown planner.plannerLlm', () => {
    assert.throws(
      () =>
        assertCoordinatorConfigShape({
          planner: { type: 'llm', plannerLlm: 'bogus' },
        }),
      /plannerLlm must be one of main \| planner \| helper/,
    );
  });
  it('rejects a non-object planner', () => {
    assert.throws(
      () => assertCoordinatorConfigShape({ planner: 'llm' }),
      /must be an object/,
    );
    assert.throws(
      () => assertCoordinatorConfigShape({ planner: null }),
      /must be an object/,
    );
    assert.throws(
      () => assertCoordinatorConfigShape({ planner: ['llm'] }),
      /must be an object/,
    );
  });
  it('accepts a DAG coordinator with a reviewer', () => {
    assert.doesNotThrow(() =>
      assertCoordinatorConfigShape({
        planner: { type: 'llm' },
        reviewer: { type: 'llm', plannerLlm: 'helper' },
      }),
    );
  });
  it('rejects an unknown reviewer.type', () => {
    assert.throws(
      () =>
        assertCoordinatorConfigShape({
          planner: { type: 'llm' },
          reviewer: { type: 'bogus' },
        }),
      /reviewer: unknown type 'bogus'/,
    );
  });
  it('rejects a bad reviewer.plannerLlm', () => {
    assert.throws(
      () =>
        assertCoordinatorConfigShape({
          planner: { type: 'llm' },
          reviewer: { type: 'llm', plannerLlm: 'bogus' },
        }),
      /reviewer\.plannerLlm must be one of/,
    );
  });
  it('rejects reviewer in a linear coordinator', () => {
    assert.throws(
      () =>
        assertCoordinatorConfigShape({
          planning: 'one-shot',
          reviewer: { type: 'llm' },
        }),
      /reviewer/,
    );
  });
});
