import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CircuitBreaker } from '@mcp-abap-adt/llm-agent';
import { SmartAgent } from '../../agent.js';
import { InMemoryMetrics } from '../../metrics/in-memory-metrics.js';
import { makeDefaultDeps, makeFailingRag, makeRag, } from '../../testing/index.js';
import { HealthChecker } from '../health-checker.js';
const DEFAULT_CONFIG = { maxIterations: 5 };
describe('HealthChecker', () => {
    it('returns healthy when all components are OK', async () => {
        const { deps } = makeDefaultDeps();
        const agent = new SmartAgent(deps, DEFAULT_CONFIG);
        const checker = new HealthChecker({
            agent,
            startTime: Date.now() - 1000,
            version: '2.3.0',
        });
        const status = await checker.check();
        assert.equal(status.status, 'healthy');
        assert.equal(status.version, '2.3.0');
        assert.ok(status.uptime >= 1000);
        assert.ok(status.timestamp);
        assert.ok(status.components.llm);
        assert.ok(status.components.rag);
    });
    it('returns degraded when RAG is down', async () => {
        const { deps } = makeDefaultDeps({
            ragStores: {
                facts: makeFailingRag(),
                feedback: makeRag(),
                state: makeRag(),
            },
        });
        const agent = new SmartAgent(deps, DEFAULT_CONFIG);
        const checker = new HealthChecker({
            agent,
            startTime: Date.now(),
            version: '2.3.0',
        });
        const status = await checker.check();
        assert.equal(status.status, 'degraded');
    });
    it('returns unhealthy when LLM is down', async () => {
        const { deps } = makeDefaultDeps({
            llmResponses: [new Error('LLM unreachable')],
        });
        const agent = new SmartAgent(deps, DEFAULT_CONFIG);
        const checker = new HealthChecker({
            agent,
            startTime: Date.now(),
            version: '2.3.0',
        });
        const status = await checker.check();
        assert.equal(status.status, 'unhealthy');
    });
    it('returns degraded when a circuit breaker is open', async () => {
        const { deps } = makeDefaultDeps();
        const agent = new SmartAgent(deps, DEFAULT_CONFIG);
        const breaker = new CircuitBreaker({ failureThreshold: 1 });
        breaker.recordFailure();
        assert.equal(breaker.state, 'open');
        const checker = new HealthChecker({
            agent,
            startTime: Date.now(),
            version: '2.3.0',
            circuitBreakers: [breaker],
        });
        const status = await checker.check();
        assert.equal(status.status, 'degraded');
        assert.ok(status.circuitBreakers);
        assert.equal(status.circuitBreakers.length, 1);
        assert.equal(status.circuitBreakers[0].state, 'open');
    });
    it('includes metrics snapshot when InMemoryMetrics is provided', async () => {
        const { deps } = makeDefaultDeps();
        const agent = new SmartAgent(deps, DEFAULT_CONFIG);
        const metrics = new InMemoryMetrics();
        metrics.requestCount.add(5);
        const checker = new HealthChecker({
            agent,
            startTime: Date.now(),
            version: '2.3.0',
            metrics,
        });
        const status = await checker.check();
        assert.ok(status.metrics);
        assert.equal(status.metrics.requestCount.total, 5);
    });
    it('omits circuitBreakers and metrics when not configured', async () => {
        const { deps } = makeDefaultDeps();
        const agent = new SmartAgent(deps, DEFAULT_CONFIG);
        const checker = new HealthChecker({
            agent,
            startTime: Date.now(),
            version: '1.0.0',
        });
        const status = await checker.check();
        assert.equal(status.circuitBreakers, undefined);
        assert.equal(status.metrics, undefined);
    });
});
//# sourceMappingURL=health-checker.test.js.map