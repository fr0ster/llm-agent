import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isToolCatalogReporter } from '@mcp-abap-adt/llm-agent';
import { ToolCatalogStatusHolder } from './tool-catalog-status.js';

describe('ToolCatalogStatusHolder', () => {
  it('stays unknown when nothing is published — the skipped-run path', () => {
    // The builder guards with `if (toolSummary)`, so a read-only store leaves
    // the holder empty rather than storing a zeroed summary. HealthChecker then
    // reports healthy.
    assert.equal(
      new ToolCatalogStatusHolder().getToolCatalogStatus(),
      undefined,
    );
  });

  it('starts unknown and reports what was published', () => {
    const h = new ToolCatalogStatusHolder();
    assert.equal(isToolCatalogReporter(h), true);
    assert.equal(h.getToolCatalogStatus(), undefined);
    h.publish({
      total: 356,
      vectorized: 338,
      failed: ['A'],
      clientFailures: 0,
      complete: false,
    });
    assert.equal(h.getToolCatalogStatus()?.vectorized, 338);
    assert.equal(h.getToolCatalogStatus()?.complete, false);
  });
});
