import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ToolCatalogStatus } from '@mcp-abap-adt/llm-agent';
import type { HealthCheckerDeps } from './health-checker.js';
import { HealthChecker } from './health-checker.js';

function makeAgent(status: ToolCatalogStatus | undefined, hasReporter = true) {
  const base = {
    healthCheck: async () => ({
      ok: true as const,
      value: { llm: true, rag: true, mcp: [] },
    }),
  };
  return hasReporter ? { ...base, getToolCatalogStatus: () => status } : base;
}

function deps(agent: unknown): HealthCheckerDeps {
  return {
    agent,
    startTime: Date.now(),
    version: '0.0.0',
  } as unknown as HealthCheckerDeps;
}

const complete: ToolCatalogStatus = {
  total: 5,
  vectorized: 5,
  failed: [],
  clientFailures: 0,
  complete: true,
};

describe('HealthChecker tool catalog', () => {
  it('is degraded when the catalog is incomplete', async () => {
    const s = await new HealthChecker(
      deps(
        makeAgent({
          total: 356,
          vectorized: 338,
          failed: ['A'],
          clientFailures: 0,
          complete: false,
        }),
      ),
    ).check();
    assert.equal(s.status, 'degraded');
    assert.equal(s.components.toolCatalog?.vectorized, 338);
    assert.equal(s.components.toolCatalog?.complete, false);
  });

  it('is degraded when a client failed to list even though counts match', async () => {
    // The case counters alone report as healthy: the failing client's tools
    // never reached `total`, so vectorized === total.
    const s = await new HealthChecker(
      deps(
        makeAgent({
          total: 10,
          vectorized: 10,
          failed: [],
          clientFailures: 1,
          complete: false,
        }),
      ),
    ).check();
    assert.equal(s.status, 'degraded');
    assert.equal(s.components.toolCatalog?.clientFailures, 1);
  });

  it('is healthy for a complete catalog', async () => {
    const s = await new HealthChecker(deps(makeAgent(complete))).check();
    assert.equal(s.status, 'healthy');
    assert.equal(s.components.toolCatalog?.total, 5);
  });

  it('is healthy when nothing was vectorized or no reporter exists', async () => {
    const noStatus = await new HealthChecker(
      deps(makeAgent(undefined)),
    ).check();
    assert.equal(noStatus.status, 'healthy');
    assert.equal(noStatus.components.toolCatalog, undefined);

    const noReporter = await new HealthChecker(
      deps(makeAgent(undefined, false)),
    ).check();
    assert.equal(noReporter.status, 'healthy');
    assert.equal(noReporter.components.toolCatalog, undefined);
  });
});
