/**
 * The strategies are the whole mechanism now — nothing waits unless a consumer
 * says so — and the documentation tells them to annotate with the type. A
 * package with one "." export offers no second door: anything left out of the
 * index is unreachable, and the mechanism would be advice nobody can take.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_THROTTLE_POLICY,
  type IThrottleStrategy,
  ReportThrottling,
  type ThrottleContext,
  type ThrottleDecision,
  type ThrottlePolicy,
  WaitAsTold,
} from '../../index.js';

describe('the throttle strategies are reachable from the package root', () => {
  it('lets a consumer write one against the exported types', () => {
    const onceOnly: IThrottleStrategy = {
      name: 'once',
      decide: ({
        attempt,
        retryAfterSeconds,
      }: ThrottleContext): ThrottleDecision => ({
        waitMs: (retryAfterSeconds ?? 0) * 1000,
        retry: attempt < 2,
      }),
    };
    const policy: Partial<ThrottlePolicy> = { strategy: onceOnly };
    assert.equal(policy.strategy?.name, 'once');
  });

  it('ships the reporting one, which is the default', () => {
    const report = new ReportThrottling();
    assert.equal(report.name, 'report');
    const decision = report.decide({
      attempt: 1,
      retryAfterSeconds: 30,
      waitedMs: 0,
      policy: { ...DEFAULT_THROTTLE_POLICY },
    });
    assert.deepEqual(decision, {
      waitMs: 30_000,
      retry: false,
      reason: 'reported',
    });
  });

  it('ships the waiting one, for a caller with nobody waiting on it', () => {
    const wait = new WaitAsTold();
    assert.equal(wait.name, 'wait-as-told');
    const policy: ThrottlePolicy = { ...DEFAULT_THROTTLE_POLICY };

    const told = wait.decide({
      attempt: 1,
      retryAfterSeconds: 7,
      waitedMs: 0,
      policy,
    });
    assert.deepEqual(told, { waitMs: 7000, retry: true });

    const untold = wait.decide({ attempt: 1, waitedMs: 0, policy });
    assert.equal(untold.retry, false);
    assert.equal(untold.reason, 'no-interval');

    const spent = wait.decide({
      attempt: policy.maxAttempts,
      retryAfterSeconds: 7,
      waitedMs: 0,
      policy,
    });
    assert.equal(spent.retry, false);
    assert.equal(spent.reason, 'attempts');
  });
});
