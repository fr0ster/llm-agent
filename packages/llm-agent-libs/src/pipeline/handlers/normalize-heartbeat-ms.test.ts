import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeHeartbeatMs } from './normalize-heartbeat-ms.js';

describe('normalizeHeartbeatMs', () => {
  it('undefined → the fixed default 5000', () => {
    assert.equal(normalizeHeartbeatMs(undefined), 5000);
  });
  it('finite positive → itself', () => {
    assert.equal(normalizeHeartbeatMs(1), 1);
    assert.equal(normalizeHeartbeatMs(5000), 5000);
    assert.equal(normalizeHeartbeatMs(30000), 30000);
  });
  it('zero and negatives → null (disabled)', () => {
    assert.equal(normalizeHeartbeatMs(0), null);
    assert.equal(normalizeHeartbeatMs(-1), null);
    assert.equal(normalizeHeartbeatMs(-5000), null);
  });
  it('non-finite (NaN / ±Infinity) → null (disabled), never a value', () => {
    assert.equal(normalizeHeartbeatMs(Number.NaN), null);
    assert.equal(normalizeHeartbeatMs(Number.POSITIVE_INFINITY), null);
    assert.equal(normalizeHeartbeatMs(Number.NEGATIVE_INFINITY), null);
  });
  it('the max Node timer delay (2^31-1) is still valid', () => {
    assert.equal(normalizeHeartbeatMs(2_147_483_647), 2_147_483_647);
  });
  it('above the max Node timer delay → null (disabled), never a value', () => {
    // Node clamps a setTimeout delay > 2^31-1 to 1ms (TimeoutOverflowWarning);
    // combined with the watchdog's auto re-arm that is a busy loop. Reject it.
    assert.equal(normalizeHeartbeatMs(2_147_483_648), null);
    assert.equal(normalizeHeartbeatMs(Number.MAX_VALUE), null);
  });
});
