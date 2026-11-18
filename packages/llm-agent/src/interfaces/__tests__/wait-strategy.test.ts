import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DefaultWaitStrategy } from '../wait-strategy.js';

test('waits for the entire delay above the Node timer range', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const maxTimerDelayMs = 2 ** 31 - 1;
  let elapsed = false;
  const pending = new DefaultWaitStrategy()
    .wait(maxTimerDelayMs + 10)
    .then((result) => {
      elapsed = true;
      return result;
    });
  t.mock.timers.tick(maxTimerDelayMs);
  await Promise.resolve();
  t.mock.timers.tick(9);
  await Promise.resolve();
  assert.equal(elapsed, false);
  t.mock.timers.tick(1);
  assert.equal(await pending, 'elapsed');
});

test('DefaultWaitStrategy resolves elapsed after the delay', async () => {
  const t0 = Date.now();
  assert.equal(await new DefaultWaitStrategy().wait(20), 'elapsed');
  assert.ok(Date.now() - t0 >= 15);
});

test('DefaultWaitStrategy returns aborted immediately for an already-aborted signal', async () => {
  const ac = new AbortController();
  ac.abort();
  const t0 = Date.now();
  assert.equal(
    await new DefaultWaitStrategy().wait(60_000, ac.signal),
    'aborted',
  );
  assert.ok(Date.now() - t0 < 100, 'must not wait out the duration');
});

test('DefaultWaitStrategy resolves aborted when the signal fires mid-wait', async () => {
  const ac = new AbortController();
  const p = new DefaultWaitStrategy().wait(60_000, ac.signal);
  ac.abort();
  assert.equal(await p, 'aborted');
});

test('DefaultWaitStrategy treats a non-positive duration as elapsed', async () => {
  assert.equal(await new DefaultWaitStrategy().wait(0), 'elapsed');
});
