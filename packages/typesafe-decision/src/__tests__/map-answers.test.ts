import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DecisionQuestion } from '@mcp-abap-adt/llm-agent';
import { mapAnswers } from '../map-answers.js';

const noulQ: Record<string, DecisionQuestion> = { a: { type: 'noul' } };
const choiceQ: Record<string, DecisionQuestion> = {
  a: { type: 'choice', criteria: { x: 'X', y: 'Y' } },
};
const scoreQ: Record<string, DecisionQuestion> = {
  a: { type: 'score', criteria: ['lo', 'mid', 'hi'] },
};

function rejects(q: Record<string, DecisionQuestion>, a: unknown, why: string) {
  const r = mapAnswers(q, { a });
  assert.ok(!r.ok, `expected rejection: ${why}`);
  assert.equal(r.error.code, 'DECISION_ERROR');
  assert.match(r.error.message, /'a'/);
}

describe('noul probability', () => {
  for (const [bad, why] of [
    [undefined, 'absent'],
    ['0.7', 'string'],
    [Number.NaN, 'NaN'],
    [Number.POSITIVE_INFINITY, 'Infinity'],
    [-0.1, 'negative'],
    [1.2, 'above 1'],
  ] as const) {
    it(`rejects ${why}`, () =>
      rejects(noulQ, { type: 'noul', noul: bad }, why));
  }
  for (const ok of [0, 1, 0.5]) {
    it(`accepts ${ok}`, () => {
      const r = mapAnswers(noulQ, { a: { type: 'noul', noul: ok } });
      assert.ok(r.ok);
      assert.deepEqual(r.value.a, { type: 'noul', probability: ok });
    });
  }
});

describe('choice', () => {
  const good = {
    type: 'choice',
    choice: 'x',
    confidence: 0.8,
    probabilities: { x: 0.8, y: 0.2 },
  };
  it('accepts a well-formed answer', () => {
    assert.ok(mapAnswers(choiceQ, { a: good }).ok);
  });
  it('rejects an unknown label', () =>
    rejects(choiceQ, { ...good, choice: 'z' }, 'unknown label'));
  it('rejects confidence above 1', () =>
    rejects(choiceQ, { ...good, confidence: 1.5 }, 'confidence'));
  it('rejects a missing label in probabilities', () =>
    rejects(choiceQ, { ...good, probabilities: { x: 1 } }, 'label set'));
  it('rejects an extra label in probabilities', () =>
    rejects(
      choiceQ,
      { ...good, probabilities: { x: 0.5, y: 0.3, z: 0.2 } },
      'extra label',
    ));
  it('rejects a non-finite probability', () =>
    rejects(
      choiceQ,
      { ...good, probabilities: { x: Number.NaN, y: 0.2 } },
      'NaN prob',
    ));
});

describe('score', () => {
  const good = {
    type: 'score',
    score: 1.4,
    confidence: 0.6,
    probabilities: { 0: 0.1, 1: 0.4, 2: 0.5 },
  };
  it('accepts a well-formed answer', () => {
    assert.ok(mapAnswers(scoreQ, { a: good }).ok);
  });
  it('accepts the boundaries 0 and levels - 1', () => {
    assert.ok(mapAnswers(scoreQ, { a: { ...good, score: 0 } }).ok);
    assert.ok(mapAnswers(scoreQ, { a: { ...good, score: 2 } }).ok);
  });
  it('rejects a score above levels - 1', () =>
    rejects(scoreQ, { ...good, score: 2.1 }, 'score range'));
  it('rejects a negative score', () =>
    rejects(scoreQ, { ...good, score: -0.5 }, 'negative score'));
  it('rejects a missing level key', () =>
    rejects(scoreQ, { ...good, probabilities: { 0: 0.5, 1: 0.5 } }, 'keys'));
  it('rejects a non-integer level key', () =>
    rejects(
      scoreQ,
      { ...good, probabilities: { 0: 0.1, 1: 0.4, 1.5: 0.5 } },
      'non-integer key',
    ));
  it('rejects a string confidence', () =>
    rejects(scoreQ, { ...good, confidence: '0.6' }, 'string confidence'));
});

it('does not require probabilities to sum to 1', () => {
  const r = mapAnswers(choiceQ, {
    a: {
      type: 'choice',
      choice: 'x',
      confidence: 0.8,
      probabilities: { x: 0.8, y: 0.3 },
    },
  });
  assert.ok(r.ok);
});
