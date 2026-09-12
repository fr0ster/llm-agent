/**
 * The strategy seam is the whole replacement for the `enabled` switch that was
 * removed, and the documentation tells consumers to annotate with the type. A
 * package with one "." export offers no second door: anything left out of the
 * index is unreachable, and the replacement would be advice nobody can take.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_THROTTLE_POLICY,
  DefaultThrottleStrategy,
  type IThrottleStrategy,
  type ThrottleContext,
  type ThrottleDecision,
  type ThrottlePolicy,
} from '../../index.js';

describe('the throttle strategy is reachable from the package root', () => {
  it('lets a consumer write one against the exported types', () => {
    const giveUpAtOnce: IThrottleStrategy = {
      name: 'no-wait',
      decide: ({ retryAfterSeconds }: ThrottleContext): ThrottleDecision => ({
        waitMs: (retryAfterSeconds ?? 0) * 1000,
        retry: false,
        reason: 'attempts',
      }),
    };
    const policy: Partial<ThrottlePolicy> = { strategy: giveUpAtOnce };
    assert.equal(policy.strategy?.name, 'no-wait');
  });

  it('ships the default one, so a consumer can wrap rather than replace', () => {
    const base = new DefaultThrottleStrategy();
    assert.equal(base.name, 'default-throttle');

    const policy: ThrottlePolicy = { ...DEFAULT_THROTTLE_POLICY };
    const served = base.decide({
      attempt: 1,
      retryAfterSeconds: 7,
      waitedMs: 0,
      policy,
    });
    assert.deepEqual(served, { waitMs: 7000, retry: true });

    const spent = base.decide({
      attempt: policy.maxAttempts,
      waitedMs: 0,
      policy,
    });
    assert.equal(spent.retry, false);
    assert.equal(spent.reason, 'attempts');
  });
});
