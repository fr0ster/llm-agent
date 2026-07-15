import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DefaultStepExecutionControl } from '../default-step-execution-control.js';

const ctx = (maxToolCalls?: number, perStepTimeoutMs?: number) => ({
  stepName: 's1',
  seq: 0,
  attempt: 0,
  budgets: { maxToolCalls, perStepTimeoutMs },
});

test('canExecuteTool: prospective +1 count', () => {
  const b = new DefaultStepExecutionControl().beginStep(ctx(3));
  assert.deepEqual(
    b.canExecuteTool({ round: 0, toolCallCount: 2, elapsedMs: 0 }),
    { continue: true },
  );
  assert.deepEqual(
    b.canExecuteTool({ round: 0, toolCallCount: 3, elapsedMs: 0 }),
    {
      continue: false,
      reason: 'maxToolCalls',
    },
  );
  b.dispose();
});

test('shouldContinueRound: time only, no count cut at ==max', () => {
  const b = new DefaultStepExecutionControl().beginStep(ctx(3));
  // at exactly max, a round may still finish with content → NOT cut
  assert.deepEqual(
    b.shouldContinueRound({ round: 5, toolCallCount: 3, elapsedMs: 0 }),
    { continue: true },
  );
  b.dispose();
});

test('time budget: shouldContinueRound cuts after elapsed >= perStepTimeoutMs; signal fires', async () => {
  const b = new DefaultStepExecutionControl().beginStep(ctx(3, 20));
  assert.deepEqual(
    b.shouldContinueRound({ round: 0, toolCallCount: 0, elapsedMs: 25 }),
    {
      continue: false,
      reason: 'step-timeout',
    },
  );
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(b.signal.aborted, true);
  b.dispose();
});

test('no perStepTimeoutMs → never-firing signal, round never time-cut', async () => {
  const b = new DefaultStepExecutionControl().beginStep(ctx(3));
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(b.signal.aborted, false);
  assert.deepEqual(
    b.shouldContinueRound({ round: 100, toolCallCount: 0, elapsedMs: 10_000 }),
    { continue: true },
  );
  b.dispose();
});
