import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isCallerCancellation } from '../caller-cancellation.js';

describe('isCallerCancellation', () => {
  it('is false without a signal', () => {
    assert.equal(isCallerCancellation(undefined), false);
  });
  it('is false for a signal that is not aborted', () => {
    assert.equal(isCallerCancellation(new AbortController().signal), false);
  });
  it('is true for a plain abort', () => {
    const ctrl = new AbortController();
    ctrl.abort();
    assert.equal(isCallerCancellation(ctrl.signal), true);
  });
  it('is false for a TimeoutError abort', () => {
    const ctrl = new AbortController();
    ctrl.abort(new DOMException('x', 'TimeoutError'));
    assert.equal(isCallerCancellation(ctrl.signal), false);
  });
  it('AbortSignal.any keeps the reason of the signal that fired', () => {
    const caller = new AbortController();
    const timeout = new AbortController();
    const any = AbortSignal.any([caller.signal, timeout.signal]);
    timeout.abort(new DOMException('x', 'TimeoutError'));
    assert.equal(isCallerCancellation(any), false);
    const caller2 = new AbortController();
    const timeout2 = new AbortController();
    const any2 = AbortSignal.any([caller2.signal, timeout2.signal]);
    caller2.abort();
    assert.equal(isCallerCancellation(any2), true);
  });
});
