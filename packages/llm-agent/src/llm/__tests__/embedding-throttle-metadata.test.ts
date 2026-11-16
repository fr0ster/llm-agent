import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WaitAsTold } from '../../interfaces/throttle-strategy.js';
import {
  httpStatusOf,
  parseRetryAfter,
  retryAfterSecondsOf,
} from '../throttle.js';

test('shared Retry-After parser handles seconds, dates and malformed values', (t) => {
  t.mock.method(Date, 'now', () => Date.parse('2026-01-01T00:00:00Z'));
  assert.equal(parseRetryAfter(' 1.25 '), 1.25);
  assert.equal(parseRetryAfter('0'), 0);
  assert.equal(parseRetryAfter('Thu, 01 Jan 2026 00:00:03 GMT'), 3);
  assert.equal(parseRetryAfter('Wed, 31 Dec 2025 23:59:00 GMT'), 0);
  for (const raw of [
    null,
    undefined,
    '',
    ' ',
    '-5',
    'Infinity',
    'NaN',
    'invalid',
  ]) {
    assert.equal(parseRetryAfter(raw), undefined);
  }
});

test('metadata readers support direct, SDK, parsed and cyclic errors', () => {
  const inner = { response: { status: 429, headers: { 'Retry-After': '2' } } };
  assert.equal(httpStatusOf(new Error('SDK', { cause: inner })), 429);
  assert.equal(retryAfterSecondsOf(inner), 2);
  assert.equal(
    retryAfterSecondsOf({ headers: new Headers({ 'Retry-After': '3' }) }),
    3,
  );
  assert.equal(retryAfterSecondsOf({ retryAfterSeconds: 0, cause: inner }), 0);
  assert.equal(retryAfterSecondsOf({ retryAfterSeconds: -1, cause: inner }), 2);
  const cycle: { cause?: object } = {};
  cycle.cause = cycle;
  assert.equal(httpStatusOf(cycle), undefined);
  assert.equal(retryAfterSecondsOf(cycle), undefined);
});

test('WaitAsTold fallback uses exponential backoff without an attempt or time budget', () => {
  const strategy = new WaitAsTold({ fallbackBackoffMs: 2000 });
  const context = { source: 'response', waitedMs: Number.MAX_VALUE } as const;
  assert.deepEqual(strategy.decide({ ...context, attempt: 1 }), {
    waitMs: 2000,
    retry: true,
  });
  assert.deepEqual(strategy.decide({ ...context, attempt: 2 }), {
    waitMs: 4000,
    retry: true,
  });
  assert.deepEqual(strategy.decide({ ...context, attempt: 10000 }), {
    waitMs: Number.MAX_VALUE,
    retry: true,
  });
  assert.deepEqual(
    strategy.decide({ ...context, attempt: 10000, retryAfterSeconds: 0.5 }),
    { waitMs: 500, retry: true },
  );
  assert.deepEqual(
    strategy.decide({ ...context, attempt: 10000, retryAfterSeconds: 0 }),
    { waitMs: 0, retry: true },
  );
  assert.deepEqual(new WaitAsTold().decide({ ...context, attempt: 1 }), {
    waitMs: 0,
    retry: false,
    reason: 'no-interval',
  });
  for (const fallbackBackoffMs of [-1, Infinity, NaN]) {
    assert.throws(() => new WaitAsTold({ fallbackBackoffMs }), RangeError);
  }
});
