import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { NormalizedLlmMap } from '../llm-config-map.js';
import {
  assertNamedLlmKeys,
  dagNamedLlmKeys,
  parseDagSettings,
  parseLinearSettings,
  parseStepperSettings,
} from '../pipeline-settings.js';

const noWarn = () => {};

describe('parseLinearSettings', () => {
  it('defaults what it did at build time', () => {
    assert.deepEqual(parseLinearSettings(undefined), {
      planning: 'one-shot',
      maxSteps: 10,
      maxRetriesPerStep: 1,
      failPolicy: 'abort',
    });
  });
  it('refuses an unknown planning or dispatch at parse, not at the first session', () => {
    assert.throws(
      () => parseLinearSettings({ planning: 'guess' }),
      /coordinator.planning.*'guess'/,
    );
    assert.throws(
      () => parseLinearSettings({ dispatch: 'fax' }),
      /coordinator.dispatch.*'fax'/,
    );
  });
  it('refuses a section that is not an object', () => {
    assert.throws(
      () => parseLinearSettings('linear'),
      /pipeline 'linear'.*must be an object/,
    );
  });
});

describe('parseStepperSettings', () => {
  it('delegates to parseStepperCoordinatorConfig', () => {
    assert.equal(
      parseStepperSettings({ mode: 'planned-react' }).mode,
      'planned-react',
    );
    assert.throws(
      () => parseStepperSettings({ mode: 'nope' }),
      /unknown coordinator.mode/,
    );
  });
});

describe('parseDagSettings', () => {
  it('requires a planner', () => {
    assert.throws(() => parseDagSettings({}, noWarn), /requires a 'planner'/);
  });
  it('lifts the keys and defaults activation', () => {
    const s = parseDagSettings(
      {
        planner: { type: 'llm', plannerLlm: 'strong' },
        reviewer: { type: 'llm', reviewerLlm: 'cheap' },
        finalizer: { type: 'llm', finalizerLlm: 'cheap' },
        stateOracle: 'inspector',
        errorStrategy: { type: 'replan', maxReplans: 2 },
        maxRoundTrips: 4,
      },
      noWarn,
    );
    assert.equal(s.plannerLlm, 'strong');
    assert.deepEqual(s.reviewer, { reviewerLlm: 'cheap' });
    assert.equal(s.activation, 'explicit');
    assert.deepEqual(s.errorStrategy, { type: 'replan', maxReplans: 2 });
    assert.deepEqual(dagNamedLlmKeys(s), ['strong', 'cheap', 'cheap']);
  });
  it('maps the deprecated reviewer.plannerLlm alias and warns once', () => {
    const warnings: string[] = [];
    const s = parseDagSettings(
      { planner: {}, reviewer: { plannerLlm: 'main' } },
      (m) => warnings.push(m),
    );
    assert.deepEqual(s.reviewer, { reviewerLlm: 'main' });
    assert.equal(warnings.length, 1);
  });
  it('an absent reviewer block stays absent; an empty one asks the role default', () => {
    assert.equal(parseDagSettings({ planner: {} }, noWarn).reviewer, undefined);
    assert.deepEqual(
      parseDagSettings({ planner: {}, reviewer: {} }, noWarn).reviewer,
      {},
    );
  });
  it('refuses a key that is not a string, and an unknown activation', () => {
    assert.throws(
      () => parseDagSettings({ planner: { plannerLlm: 5 } }, noWarn),
      /planner.plannerLlm.*llm: key/,
    );
    assert.throws(
      () => parseDagSettings({ planner: {}, activation: 'sometimes' }, noWarn),
      /coordinator.activation.*'sometimes'/,
    );
  });
  it('a finalizer key counts only for type llm', () => {
    const s = parseDagSettings(
      { planner: {}, finalizer: { type: 'template', finalizerLlm: 'cheap' } },
      noWarn,
    );
    assert.deepEqual(dagNamedLlmKeys(s), []);
  });
});

describe('assertNamedLlmKeys', () => {
  const map = { main: {}, cheap: {} } as unknown as NormalizedLlmMap;
  it('passes for declared keys, main included', () => {
    assertNamedLlmKeys(['main', 'cheap'], map, "pipeline 'dag'");
  });
  it('refuses a key with no entry, naming it and where it was named', () => {
    assert.throws(
      () => assertNamedLlmKeys(['cheep'], map, "pipeline 'dag'"),
      /pipeline 'dag' names llm: key 'cheep'.*declared: main, cheap/,
    );
  });
});
