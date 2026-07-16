import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cancelableDelay } from '../cancelable-delay.js';

test('cancelableDelay resolves after the delay', async () => {
  const t0 = Date.now();
  await cancelableDelay(30);
  assert.ok(Date.now() - t0 >= 25);
});

test('cancelableDelay rejects immediately when the signal is already aborted', async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(cancelableDelay(1000, ctrl.signal));
});

test('cancelableDelay rejects when aborted mid-wait (and does not hang past abort)', async () => {
  const ctrl = new AbortController();
  const p = cancelableDelay(10_000, ctrl.signal);
  setTimeout(() => ctrl.abort(), 10);
  await assert.rejects(p);
});
