import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isRetrievalMetrics } from '../collection-profile.js';

describe('isRetrievalMetrics', () => {
  it('accepts an object whose retrievalOutcome is a counter', () => {
    assert.equal(isRetrievalMetrics({ retrievalOutcome: { add() {} } }), true);
  });
  it('refuses anything else', () => {
    for (const v of [
      undefined,
      null,
      1,
      {},
      { retrievalOutcome: {} },
      { retrievalOutcome: { add: 1 } },
    ]) {
      assert.equal(isRetrievalMetrics(v), false);
    }
  });
});
