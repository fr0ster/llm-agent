import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeWait, isWaitStep, planWait } from '../wait-step.js';

const step = (waitMs?: number) =>
  ({
    name: 'w',
    instructions: 'w',
    type: 'wait',
    ...(waitMs ? { waitMs } : {}),
  }) as never;

const call = (o: Partial<Parameters<typeof planWait>[0]>) =>
  planWait({
    step: step(30_000),
    inFlight: {},
    maxWaitMs: 600_000,
    maxTotalWaitMs: 1_800_000,
    waitMsUsed: 0,
    now: 1_000_000,
    ...o,
  });

test('isWaitStep is true only for type wait', () => {
  assert.equal(
    isWaitStep({ name: 'a', instructions: 'b', type: 'wait' } as never),
    true,
  );
  assert.equal(isWaitStep({ name: 'a', instructions: 'b' } as never), false);
  assert.equal(
    isWaitStep({ name: 'a', instructions: 'b', type: 'other' } as never),
    false,
  );
});

test('fresh: honours a planner duration inside the working range', () => {
  for (const ms of [30_000, 90_000, 120_000, 360_000]) {
    const p = call({ step: step(ms) });
    assert.deepEqual(p, {
      kind: 'fresh',
      applied: ms,
      clamped: false,
      cappedSkip: false,
    });
  }
});

test('fresh: clamps above maxWaitMs and reports it', () => {
  const p = call({ step: step(3_600_000) });
  assert.deepEqual(p, {
    kind: 'fresh',
    applied: 600_000,
    clamped: true,
    cappedSkip: false,
  });
});

test('fresh: partial remaining cap truncates but is NOT a skip', () => {
  const p = call({ step: step(30_000), waitMsUsed: 1_790_000 });
  assert.deepEqual(p, {
    kind: 'fresh',
    applied: 10_000,
    clamped: true,
    cappedSkip: false,
  });
});

test('fresh: cap fully spent is a skip, not a clamp', () => {
  const p = call({ step: step(30_000), waitMsUsed: 1_800_000 });
  assert.deepEqual(p, {
    kind: 'fresh',
    applied: 0,
    clamped: false,
    cappedSkip: true,
  });
});

test('resume: sleeps only the remainder, never recomputes', () => {
  const p = planWait({
    step: step(30_000),
    inFlight: { waitStartedAt: 1_000_000, appliedWaitMs: 30_000 },
    maxWaitMs: 5_000,
    maxTotalWaitMs: 0,
    waitMsUsed: 999_999,
    now: 1_010_000,
  });
  // maxWaitMs/cap changed since — must NOT move the deadline.
  assert.deepEqual(p, {
    kind: 'resume',
    remaining: 20_000,
    deadlinePassed: false,
  });
});

test('resume: deadline already passed → remaining 0', () => {
  const p = planWait({
    step: step(30_000),
    inFlight: { waitStartedAt: 1_000_000, appliedWaitMs: 30_000 },
    maxWaitMs: 600_000,
    maxTotalWaitMs: 1_800_000,
    waitMsUsed: 30_000,
    now: 9_000_000,
  });
  assert.deepEqual(p, { kind: 'resume', remaining: 0, deadlinePassed: true });
});

test('torn: exactly one deadline field present, either way round', () => {
  assert.deepEqual(call({ inFlight: { waitStartedAt: 5 } }), {
    kind: 'torn',
    missing: 'appliedWaitMs',
  });
  assert.deepEqual(call({ inFlight: { appliedWaitMs: 5 } }), {
    kind: 'torn',
    missing: 'waitStartedAt',
  });
});

test('describeWait: formats fresh, resume, and torn plans', () => {
  const s = step(30_000);
  assert.match(
    describeWait(
      { kind: 'fresh', applied: 30_000, clamped: false, cappedSkip: false },
      s,
    ),
    /30000\s*ms/,
  );
  assert.match(
    describeWait(
      { kind: 'fresh', applied: 0, clamped: false, cappedSkip: true },
      s,
    ),
    /skip/i,
  );
  assert.match(
    describeWait(
      { kind: 'resume', remaining: 20_000, deadlinePassed: false },
      s,
    ),
    /20000\s*ms/,
  );
  assert.match(
    describeWait({ kind: 'torn', missing: 'appliedWaitMs' }, s),
    /appliedWaitMs/,
  );
});
