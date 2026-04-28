import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CircuitBreaker } from '../circuit-breaker.js';
describe('CircuitBreaker', () => {
    it('starts in closed state', () => {
        const cb = new CircuitBreaker();
        assert.equal(cb.state, 'closed');
        assert.ok(cb.isCallPermitted);
    });
    it('stays closed when failures are below threshold', () => {
        const cb = new CircuitBreaker({ failureThreshold: 3 });
        cb.recordFailure();
        cb.recordFailure();
        assert.equal(cb.state, 'closed');
        assert.ok(cb.isCallPermitted);
    });
    it('opens after reaching failure threshold', () => {
        const cb = new CircuitBreaker({ failureThreshold: 3 });
        cb.recordFailure();
        cb.recordFailure();
        cb.recordFailure();
        assert.equal(cb.state, 'open');
        assert.ok(!cb.isCallPermitted);
    });
    it('transitions to half-open after recovery window', () => {
        const cb = new CircuitBreaker({
            failureThreshold: 1,
            recoveryWindowMs: 10,
        });
        cb.recordFailure();
        assert.equal(cb.state, 'open');
        // Wait for recovery window to pass
        const start = Date.now();
        while (Date.now() - start < 15) {
            /* busy wait */
        }
        assert.equal(cb.state, 'half-open');
        assert.ok(cb.isCallPermitted);
    });
    it('closes on success in half-open state', () => {
        const cb = new CircuitBreaker({
            failureThreshold: 1,
            recoveryWindowMs: 10,
        });
        cb.recordFailure();
        const start = Date.now();
        while (Date.now() - start < 15) {
            /* busy wait */
        }
        assert.equal(cb.state, 'half-open');
        cb.recordSuccess();
        assert.equal(cb.state, 'closed');
    });
    it('re-opens on failure in half-open state', () => {
        const cb = new CircuitBreaker({
            failureThreshold: 1,
            recoveryWindowMs: 10,
        });
        cb.recordFailure();
        const start = Date.now();
        while (Date.now() - start < 15) {
            /* busy wait */
        }
        assert.equal(cb.state, 'half-open');
        cb.recordFailure();
        assert.equal(cb.state, 'open');
    });
    it('calls onStateChange callback on transitions', () => {
        const transitions = [];
        const cb = new CircuitBreaker({
            failureThreshold: 2,
            onStateChange: (from, to) => transitions.push({ from, to }),
        });
        cb.recordFailure();
        cb.recordFailure();
        assert.equal(transitions.length, 1);
        assert.deepEqual(transitions[0], { from: 'closed', to: 'open' });
    });
    it('resets failure count on success', () => {
        const cb = new CircuitBreaker({ failureThreshold: 3 });
        cb.recordFailure();
        cb.recordFailure();
        cb.recordSuccess();
        cb.recordFailure();
        cb.recordFailure();
        // Should not be open yet — success reset the counter
        assert.equal(cb.state, 'closed');
    });
});
//# sourceMappingURL=circuit-breaker.test.js.map