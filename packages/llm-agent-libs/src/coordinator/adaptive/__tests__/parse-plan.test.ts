import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  fallbackPlan,
  parsePlan,
  parseVerdict,
  validateSteps,
} from '../parse-plan.js';

const work = { id: 'a', kind: 'work', goal: 'g', worker: 'executor' };
const answer = { id: 'z', kind: 'answer', from: 'a' };
const opts = { workers: ['executor'] };
const raw = JSON.stringify({ steps: [work, answer] });

test('parsePlan accepts a minimal work+answer plan', () => {
  const result = parsePlan(raw, opts);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.steps.length, 2);
    assert.equal(typeof result.value.createdAt, 'number');
  }
});
test('parsePlan takes the JSON object out of surrounding prose', () => {
  assert.equal(parsePlan(`Plan:\n${raw}\nDone`, opts).ok, true);
});
for (const [name, steps, id] of [
  ['duplicate id', [work, work], 'a'],
  ['reserved id', [{ ...work, id: 'end' }], 'end'],
  ['unknown worker', [{ ...work, worker: 'missing' }], 'a'],
  [
    'unknown target',
    [
      work,
      {
        id: 'c',
        kind: 'check',
        goal: 'g',
        worker: 'self',
        targets: ['missing'],
        onPass: 'next',
        onFail: 'end',
      },
    ],
    'c',
  ],
  [
    'unknown branch',
    [
      work,
      {
        id: 'c',
        kind: 'check',
        goal: 'g',
        worker: 'self',
        targets: ['a'],
        onPass: 'next',
        onFail: 'missing',
      },
    ],
    'c',
  ],
  ['both answer sources', [work, { ...answer, text: 'hi' }], 'z'],
  ['no answer source', [{ id: 'z', kind: 'answer' }], 'z'],
  ['maxRuns cap', [{ ...work, maxRuns: 6 }], 'a'],
  ['empty steps', [], 'steps'],
] as const) {
  test(`parsePlan rejects ${name}`, () => {
    const result = parsePlan(JSON.stringify({ steps }), opts);
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.error.includes(id));
  });
}
test("check worker 'self' is allowed", () => {
  assert.equal(
    validateSteps(
      [
        work,
        {
          id: 'c',
          kind: 'check',
          goal: 'g',
          worker: 'self',
          targets: ['a'],
          onPass: 'next',
          onFail: 'end',
        },
      ],
      opts,
    ).ok,
    true,
  );
});
test('spec is kept', () => {
  const result = parsePlan(
    JSON.stringify({ spec: { objective: 'o' }, steps: [answer, work] }),
    opts,
  );
  assert.equal(result.ok, true);
  if (result.ok)
    assert.deepEqual(result.value.spec, { objective: 'o', raw: '' });
});
test('validateSteps rejects ids already taken', () => {
  assert.equal(
    validateSteps([work], { ...opts, takenIds: new Set(['a']) }).ok,
    false,
  );
});
test('parseVerdict', () => {
  assert.deepEqual(parseVerdict('{"verdict":"pass","reason":"ok"}'), {
    verdict: 'pass',
    reason: 'ok',
  });
  assert.deepEqual(parseVerdict('text {"verdict":"partial","reason":"r"}'), {
    verdict: 'partial',
    reason: 'r',
  });
  assert.equal(parseVerdict('{"verdict":"maybe"}'), undefined);
  assert.equal(parseVerdict('no json'), undefined);
  assert.deepEqual(parseVerdict('{"verdict":"fail"}'), {
    verdict: 'fail',
    reason: '',
  });
  assert.deepEqual(parseVerdict('{"verdict":"pass","reason":"ok"} then {'), {
    verdict: 'pass',
    reason: 'ok',
  });
});
test('fallbackPlan has exec then answer from exec', () => {
  assert.deepEqual(fallbackPlan('request', 'executor', 123), {
    createdAt: 123,
    steps: [
      {
        id: 'exec',
        kind: 'work',
        goal: 'request',
        worker: 'executor',
        context: { history: 'all' },
      },
      { id: 'answer', kind: 'answer', from: 'exec' },
    ],
  });
});

test('parsePlan selects the last object and handles braces in strings', () => {
  const last = JSON.stringify({
    steps: [{ id: 'z', kind: 'answer', text: 'A {quoted} "answer"' }],
  });
  const result = parsePlan(`${raw}\nRevised:\n${last}`, { ...opts, now: 0 });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.createdAt, 0);
    assert.deepEqual(result.value.steps, [
      { id: 'z', kind: 'answer', text: 'A {quoted} "answer"' },
    ]);
  }
});

test('parsePlan rejects malformed JSON and malformed shapes', () => {
  for (const input of [
    'no json',
    '{"steps":',
    '{"steps":oops}',
    '{}',
    '{"steps":null}',
    '{"spec":{"objective":7},"steps":[]}',
  ]) {
    assert.equal(parsePlan(input, opts).ok, false, input);
  }
});

test('validateSteps permits forward references and known ids', () => {
  const result = validateSteps(
    [
      {
        id: 'c',
        kind: 'check',
        goal: 'g',
        worker: 'self',
        targets: ['a', 'old'],
        context: { results: ['old', 'a'] },
        onPass: 'a',
        onFail: 'old',
        onPartial: 'next',
      },
      work,
      { ...answer, from: 'old' },
    ],
    { ...opts, knownIds: new Set(['old']), takenIds: new Set(['old']) },
  );
  assert.equal(result.ok, true);
});

test('validateSteps applies work/check/revise defaults and keeps explicit caps', () => {
  const result = validateSteps(
    [
      work,
      {
        id: 'c',
        kind: 'check',
        goal: 'g',
        worker: 'self',
        targets: ['a'],
        onPass: 'next',
        onFail: 'end',
      },
      { id: 'r', kind: 'revise', reason: 'reason' },
      { ...work, id: 'b', maxRuns: 5 },
    ],
    opts,
  );
  assert.equal(result.ok, true);
  if (result.ok)
    assert.deepEqual(
      result.value.map((step) =>
        'maxRuns' in step ? step.maxRuns : undefined,
      ),
      [1, 3, 1, 5],
    );
});

test('validateSteps rejects invalid context, references, kinds and run counts', () => {
  for (const value of [
    { ...work, id: 'next' },
    { ...work, worker: 'self' },
    { ...work, kind: 'unknown' },
    { ...work, context: { history: 'some' } },
    { ...work, context: { results: ['missing'] } },
    { ...work, maxRuns: 0 },
    { ...work, maxRuns: 1.5 },
    { ...work, maxRuns: '2' },
    { id: 'z', kind: 'answer', from: 'missing' },
  ])
    assert.equal(validateSteps([value], opts).ok, false, JSON.stringify(value));
});
