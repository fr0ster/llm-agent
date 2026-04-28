import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { makeLlm } from '../../testing/index.js';
import { CircuitBreaker } from '../circuit-breaker.js';
import { CircuitBreakerLlm } from '../circuit-breaker-llm.js';
describe('CircuitBreakerLlm', () => {
    it('passes through when circuit is closed', async () => {
        const inner = makeLlm([{ content: 'ok' }]);
        const breaker = new CircuitBreaker({ failureThreshold: 3 });
        const llm = new CircuitBreakerLlm(inner, breaker);
        const result = await llm.chat([{ role: 'user', content: 'hi' }]);
        assert.ok(result.ok);
        assert.equal(result.value.content, 'ok');
        assert.equal(breaker.state, 'closed');
    });
    it('returns CIRCUIT_OPEN error when circuit is open', async () => {
        const inner = makeLlm([{ content: 'ok' }]);
        const breaker = new CircuitBreaker({ failureThreshold: 1 });
        breaker.recordFailure(); // trip the breaker
        const llm = new CircuitBreakerLlm(inner, breaker);
        const result = await llm.chat([{ role: 'user', content: 'hi' }]);
        assert.ok(!result.ok);
        assert.equal(result.error.code, 'CIRCUIT_OPEN');
        assert.equal(inner.callCount, 0); // inner LLM not called
    });
    it('records failure on inner LLM error', async () => {
        const inner = makeLlm([new Error('LLM down')]);
        const breaker = new CircuitBreaker({ failureThreshold: 3 });
        const llm = new CircuitBreakerLlm(inner, breaker);
        const result = await llm.chat([{ role: 'user', content: 'hi' }]);
        assert.ok(!result.ok);
        // Failure should have been recorded
        assert.equal(breaker.state, 'closed'); // still below threshold
    });
    it('streamChat returns CIRCUIT_OPEN when open', async () => {
        const inner = makeLlm([{ content: 'ok' }]);
        const breaker = new CircuitBreaker({ failureThreshold: 1 });
        breaker.recordFailure();
        const llm = new CircuitBreakerLlm(inner, breaker);
        const chunks = [];
        for await (const chunk of llm.streamChat([
            { role: 'user', content: 'hi' },
        ])) {
            chunks.push(chunk);
        }
        assert.equal(chunks.length, 1);
        const first = chunks[0];
        assert.ok(!first.ok);
        assert.equal(first.error.code, 'CIRCUIT_OPEN');
    });
    it('streamChat passes through and records success when closed', async () => {
        const inner = makeLlm([{ content: 'streamed' }]);
        const breaker = new CircuitBreaker({ failureThreshold: 3 });
        const llm = new CircuitBreakerLlm(inner, breaker);
        const chunks = [];
        for await (const chunk of llm.streamChat([
            { role: 'user', content: 'hi' },
        ])) {
            chunks.push(chunk);
        }
        assert.ok(chunks.length >= 1);
        assert.equal(breaker.state, 'closed');
    });
});
//# sourceMappingURL=circuit-breaker-llm.test.js.map