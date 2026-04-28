import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SmartAgent } from '../../agent.js';
import {
  makeCapturingMetrics,
  makeClassifier,
  makeDefaultDeps,
} from '../../testing/index.js';
import { InMemoryMetrics } from '../in-memory-metrics.js';
import { NoopMetrics } from '../noop-metrics.js';

const DEFAULT_CONFIG = { maxIterations: 5 };

// ---------------------------------------------------------------------------
// NoopMetrics
// ---------------------------------------------------------------------------

describe('NoopMetrics', () => {
  it('all counters and histograms accept calls silently', () => {
    const m = new NoopMetrics();
    m.requestCount.add();
    m.requestCount.add(5, { foo: 'bar' });
    m.requestLatency.record(100);
    m.toolCallCount.add();
    m.ragQueryCount.add(1, { store: 'facts', hit: 'true' });
    m.classifierIntentCount.add(1, { intent: 'action' });
    m.llmCallCount.add();
    m.llmCallLatency.record(50);
    m.circuitBreakerTransition.add(1, { from: 'closed', to: 'open' });
  });
});

// ---------------------------------------------------------------------------
// InMemoryMetrics
// ---------------------------------------------------------------------------

describe('InMemoryMetrics', () => {
  it('counter tracks totals and attribute breakdowns', () => {
    const m = new InMemoryMetrics();
    m.requestCount.add();
    m.requestCount.add(2);
    m.requestCount.add(1, { path: '/chat' });

    const snap = m.snapshot();
    assert.equal(snap.requestCount.total, 4);
    assert.equal(snap.requestCount.byAttributes.get('path=/chat'), 1);
  });

  it('histogram records values and computes percentiles', () => {
    const m = new InMemoryMetrics();
    for (let i = 1; i <= 100; i++) {
      m.requestLatency.record(i);
    }

    const snap = m.snapshot();
    assert.equal(snap.requestLatency.count, 100);
    assert.equal(snap.requestLatency.min, 1);
    assert.equal(snap.requestLatency.max, 100);
    assert.equal(snap.requestLatency.sum, 5050);

    assert.equal(m.requestLatencyPercentile(50), 50);
    assert.equal(m.requestLatencyPercentile(99), 99);
    assert.equal(m.requestLatencyPercentile(100), 100);
  });

  it('percentile returns 0 for empty histogram', () => {
    const m = new InMemoryMetrics();
    assert.equal(m.requestLatencyPercentile(50), 0);
  });

  it('snapshot returns all metric groups', () => {
    const m = new InMemoryMetrics();
    const snap = m.snapshot();
    assert.ok('requestCount' in snap);
    assert.ok('requestLatency' in snap);
    assert.ok('toolCallCount' in snap);
    assert.ok('ragQueryCount' in snap);
    assert.ok('classifierIntentCount' in snap);
    assert.ok('llmCallCount' in snap);
    assert.ok('llmCallLatency' in snap);
    assert.ok('circuitBreakerTransition' in snap);
  });
});

// ---------------------------------------------------------------------------
// Pipeline instrumentation
// ---------------------------------------------------------------------------

describe('Pipeline metrics instrumentation', () => {
  it('increments requestCount and records requestLatency on process()', async () => {
    const metrics = makeCapturingMetrics();
    const { deps } = makeDefaultDeps({ metrics });
    const agent = new SmartAgent(deps, DEFAULT_CONFIG);

    await agent.process('hello');

    const snap = metrics.snapshot();
    assert.equal(snap.requestCount.total, 1);
    assert.equal(snap.requestLatency.count, 1);
    assert.ok(snap.requestLatency.values[0] >= 0);
  });

  it('increments classifierIntentCount per subprompt', async () => {
    const metrics = makeCapturingMetrics();
    const classifier = makeClassifier([
      { type: 'action', text: 'do X' },
      { type: 'fact', text: 'remember Y' },
    ]);
    const { deps } = makeDefaultDeps({ classifier, metrics });
    const agent = new SmartAgent(deps, DEFAULT_CONFIG);

    await agent.process('hello');

    const snap = metrics.snapshot();
    assert.equal(snap.classifierIntentCount.total, 2);
    assert.equal(
      snap.classifierIntentCount.byAttributes.get('intent=action'),
      1,
    );
    assert.equal(snap.classifierIntentCount.byAttributes.get('intent=fact'), 1);
  });

  it('increments llmCallCount per LLM invocation', async () => {
    const metrics = makeCapturingMetrics();
    const { deps } = makeDefaultDeps({ metrics });
    const agent = new SmartAgent(deps, DEFAULT_CONFIG);

    await agent.process('hello');

    const snap = metrics.snapshot();
    assert.ok(snap.llmCallCount.total >= 1);
    assert.ok(snap.llmCallLatency.count >= 1);
  });

  it('default NoopMetrics causes no errors', async () => {
    const { deps } = makeDefaultDeps();
    const agent = new SmartAgent(deps, DEFAULT_CONFIG);

    const result = await agent.process('hello');
    assert.ok(result.ok);
  });
});
