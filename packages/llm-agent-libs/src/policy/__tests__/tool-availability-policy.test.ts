/**
 * Spec §10.5.12 U8: the tool availability blacklist is an injected policy.
 * `HeuristicToolAvailabilityPolicy` ships 30.1.0's heuristic, opt-in.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HeuristicToolAvailabilityPolicy } from '../tool-availability-policy.js';

describe('HeuristicToolAvailabilityPolicy', () => {
  it('a "not found" error → block for the configured ttlMs', () => {
    const policy = new HeuristicToolAvailabilityPolicy({ ttlMs: 1000 });
    assert.deepEqual(policy.onToolError('T', 'Error: object not found'), {
      ttlMs: 1000,
    });
  });

  it('an error the heuristic does not match → undefined (not blocked)', () => {
    const policy = new HeuristicToolAvailabilityPolicy({ ttlMs: 1000 });
    assert.equal(policy.onToolError('T', 'syntax error in line 3'), undefined);
  });
});
