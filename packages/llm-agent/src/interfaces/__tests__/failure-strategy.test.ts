import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type FailureContext,
  ReportFailure,
  RetryWithBackoff,
} from '../failure-strategy.js';

const ctx = (over: Partial<FailureContext> = {}): FailureContext => ({
  attempt: 1,
  waitedMs: 0,
  midStream: false,
  error: new Error('Bad Gateway'),
  ...over,
});

describe('ReportFailure', () => {
  it('never retries and never invents a wait', () => {
    const d = new ReportFailure().decide();
    assert.deepEqual(d, { waitMs: 0, retry: false, reason: 'reported' });
  });
});

describe('RetryWithBackoff', () => {
  const strategy = new RetryWithBackoff({
    attempts: 3,
    firstWaitMs: 100,
    statuses: [500, 502, 503],
  });

  it('repeats a status it was given, waiting what it was told first', () => {
    assert.deepEqual(strategy.decide(ctx({ status: 502 })), {
      waitMs: 100,
      retry: true,
    });
  });

  it('doubles the wait per attempt, counting from the first retry', () => {
    // The old decorator computed backoffMs * 2 ** attempt with a 0-based
    // attempt, so the first wait was the configured one. Same schedule here,
    // with attempt 1-based: 100, 200, 400.
    assert.equal(strategy.decide(ctx({ status: 500, attempt: 1 })).waitMs, 100);
    assert.equal(strategy.decide(ctx({ status: 500, attempt: 2 })).waitMs, 200);
    assert.equal(strategy.decide(ctx({ status: 500, attempt: 3 })).waitMs, 400);
  });

  it('stops after the attempts it was given', () => {
    const d = strategy.decide(ctx({ status: 500, attempt: 4 }));
    assert.equal(d.retry, false);
    assert.equal(d.reason, 'attempts');
  });

  it('leaves a status it was not given alone', () => {
    const d = strategy.decide(ctx({ status: 400 }));
    assert.equal(d.retry, false);
    assert.equal(d.reason, 'not-transient');
  });

  it('reads the status out of the message when the error carries none', () => {
    // Every provider rewraps its transport error, so by the time a failure
    // reaches a strategy the status is often only in the prose.
    const d = strategy.decide(ctx({ error: new Error('HTTP 503 upstream') }));
    assert.equal(d.retry, true);
  });

  it('does not fire on digits that merely contain the code', () => {
    const d = strategy.decide(ctx({ error: new Error('read 5030 bytes') }));
    assert.equal(d.retry, false);
  });

  it('refuses a mid-stream replay unless a hint says otherwise', () => {
    const d = strategy.decide(ctx({ status: 500, midStream: true }));
    assert.equal(d.retry, false);
    assert.equal(d.reason, 'mid-stream');
  });

  it('replays mid-stream when the message matches a hint it was given', () => {
    const withHints = new RetryWithBackoff({
      attempts: 2,
      firstWaitMs: 10,
      statuses: [],
      midStreamHints: ['SSE stream'],
    });
    const d = withHints.decide(
      ctx({
        midStream: true,
        error: new Error('Error while iterating over SSE stream'),
      }),
    );
    assert.equal(d.retry, true);
  });
});
