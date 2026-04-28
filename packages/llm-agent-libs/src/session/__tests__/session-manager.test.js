import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { NoopSessionManager } from '../noop-session-manager.js';
import { SessionManager } from '../session-manager.js';

describe('SessionManager', () => {
  it('starts with zero tokens', () => {
    const sm = new SessionManager({ tokenBudget: 1000 });
    assert.equal(sm.totalTokens, 0);
    assert.equal(sm.isOverBudget(), false);
  });
  it('addTokens increments the counter', () => {
    const sm = new SessionManager({ tokenBudget: 1000 });
    sm.addTokens(400);
    assert.equal(sm.totalTokens, 400);
    sm.addTokens(300);
    assert.equal(sm.totalTokens, 700);
  });
  it('isOverBudget returns true when budget exceeded', () => {
    const sm = new SessionManager({ tokenBudget: 100 });
    sm.addTokens(50);
    assert.equal(sm.isOverBudget(), false);
    sm.addTokens(50);
    assert.equal(sm.isOverBudget(), true);
    sm.addTokens(10);
    assert.equal(sm.isOverBudget(), true);
  });
  it('reset clears the token count', () => {
    const sm = new SessionManager({ tokenBudget: 100 });
    sm.addTokens(200);
    assert.equal(sm.isOverBudget(), true);
    sm.reset();
    assert.equal(sm.totalTokens, 0);
    assert.equal(sm.isOverBudget(), false);
  });
});
describe('NoopSessionManager', () => {
  it('never reports over budget', () => {
    const sm = new NoopSessionManager();
    sm.addTokens(999_999);
    assert.equal(sm.totalTokens, 0);
    assert.equal(sm.isOverBudget(), false);
  });
  it('reset does not throw', () => {
    const sm = new NoopSessionManager();
    sm.reset();
  });
});
//# sourceMappingURL=session-manager.test.js.map
