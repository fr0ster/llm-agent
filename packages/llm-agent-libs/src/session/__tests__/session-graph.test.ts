import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionRequestLogger } from '../../logger/session-request-logger.js';
import { PendingToolResultsRegistry } from '../../policy/pending-tool-results-registry.js';
import { ToolAvailabilityRegistry } from '../../policy/tool-availability-registry.js';
import { SessionGraph } from '../session-graph.js';

function make() {
  return new SessionGraph({
    sessionId: 's1',
    toolAvailability: new ToolAvailabilityRegistry(),
    pendingToolResults: new PendingToolResultsRegistry(),
    logger: new SessionRequestLogger(),
    dispose: async () => {},
  });
}

test('refcount pins the graph; release updates lastUsed', () => {
  const g = make();
  assert.equal(g.activeRequests, 0);
  assert.equal(g.isPinned, false);
  g.acquire();
  assert.equal(g.activeRequests, 1);
  assert.equal(g.isPinned, true);
  const t0 = g.lastUsedMs;
  g.release();
  assert.equal(g.activeRequests, 0);
  assert.equal(g.isPinned, false);
  assert.ok(g.lastUsedMs >= t0);
});

test('release never goes below zero', () => {
  const g = make();
  g.release();
  assert.equal(g.activeRequests, 0);
});

test('exposes sessionId-keyed registries and logger', () => {
  const g = make();
  assert.ok(g.toolAvailability);
  assert.ok(g.pendingToolResults);
  assert.ok(g.logger);
});

test('dispose() runs the hook BEFORE logger.reset (review MEDIUM #2)', async () => {
  const order: string[] = [];
  const logger = new SessionRequestLogger();
  const origReset = logger.reset.bind(logger);
  logger.reset = () => {
    order.push('reset');
    origReset();
  };
  const g = new SessionGraph({
    sessionId: 's1',
    toolAvailability: new ToolAvailabilityRegistry(),
    pendingToolResults: new PendingToolResultsRegistry(),
    logger,
    dispose: async () => {
      order.push('hook');
    },
  });
  await g.dispose();
  assert.deepEqual(order, ['hook', 'reset'], 'hook runs before logger.reset');
});

test('dispose() logger.reset runs even if the hook throws (finally)', async () => {
  const order: string[] = [];
  const logger = new SessionRequestLogger();
  const origReset = logger.reset.bind(logger);
  logger.reset = () => {
    order.push('reset');
    origReset();
  };
  const g = new SessionGraph({
    sessionId: 's1',
    toolAvailability: new ToolAvailabilityRegistry(),
    pendingToolResults: new PendingToolResultsRegistry(),
    logger,
    dispose: async () => {
      order.push('hook');
      throw new Error('boom');
    },
  });
  await assert.rejects(() => g.dispose(), /boom/);
  assert.deepEqual(order, ['hook', 'reset']);
});

test('acquire() throws SESSION_GRAPH_DISPOSED after dispose() (race fix MEDIUM #8)', async () => {
  const g = make();
  await g.dispose();
  assert.throws(
    () => g.acquire(),
    (err: unknown) => {
      const e = err as { code?: string; message?: string };
      return (
        e.code === 'SESSION_GRAPH_DISPOSED' && /disposed/i.test(e.message ?? '')
      );
    },
  );
});

test('markForDisposal flag + dispose() runs the injected hook once', async () => {
  let n = 0;
  const g = new SessionGraph({
    sessionId: 's1',
    toolAvailability: new ToolAvailabilityRegistry(),
    pendingToolResults: new PendingToolResultsRegistry(),
    logger: new SessionRequestLogger(),
    dispose: async () => {
      n++;
    },
  });
  assert.equal(g.markedForDisposal, false);
  g.markForDisposal();
  assert.equal(g.markedForDisposal, true);
  await g.dispose();
  await g.dispose();
  assert.equal(n, 1);
});
