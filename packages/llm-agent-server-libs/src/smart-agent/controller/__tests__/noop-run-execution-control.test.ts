import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NoopRunExecutionControl } from '../noop-run-execution-control.js';

test('noop run control never fires, always continue', async () => {
  const b = new NoopRunExecutionControl().beginRun({ runId: 'r1' });
  assert.deepEqual(
    b.shouldContinue({ stepsUsed: 999, elapsedMs: 10_000_000 }),
    { continue: true },
  );
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(b.signal.aborted, false);
  b.dispose();
});
