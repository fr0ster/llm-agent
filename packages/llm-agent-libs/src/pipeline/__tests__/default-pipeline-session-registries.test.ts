import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PendingToolResultsRegistry } from '../../policy/pending-tool-results-registry.js';
import { ToolAvailabilityRegistry } from '../../policy/tool-availability-registry.js';
import { resolveSessionRegistries } from '../default-pipeline.js';

test('uses injected registries when provided', () => {
  const ta = new ToolAvailabilityRegistry();
  const pr = new PendingToolResultsRegistry();
  const out = resolveSessionRegistries({
    toolAvailability: ta,
    pendingToolResults: pr,
  });
  assert.equal(out.toolAvailability, ta);
  assert.equal(out.pendingToolResults, pr);
});

test('falls back to fresh instances when none provided', () => {
  const out = resolveSessionRegistries({});
  assert.ok(out.toolAvailability instanceof ToolAvailabilityRegistry);
  assert.ok(out.pendingToolResults instanceof PendingToolResultsRegistry);
});
