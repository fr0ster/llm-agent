import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isReadinessReporter } from '@mcp-abap-adt/llm-agent';
// Import via the package ROOT — the only supported public path (package.json
// exposes only "."). A consumer must be able to reach the factory this way.
import {
  LazyConnectionStrategy,
  makeConnectionStrategy,
  NoopConnectionStrategy,
  PeriodicConnectionStrategy,
} from '@mcp-abap-adt/llm-agent-mcp';

test('package root exports the connection-strategy public API', () => {
  assert.equal(typeof makeConnectionStrategy, 'function');
  assert.equal(typeof LazyConnectionStrategy, 'function');
  assert.equal(typeof PeriodicConnectionStrategy, 'function');
  assert.equal(typeof NoopConnectionStrategy, 'function');
});

test('makeConnectionStrategy() returns a readiness-reporting strategy', () => {
  const strategy = makeConnectionStrategy([]); // no targets configured
  try {
    assert.equal(isReadinessReporter(strategy), true);
    assert.equal(strategy.isReady(), true, 'no targets ⇒ ready');
  } finally {
    void strategy.dispose();
  }
});
