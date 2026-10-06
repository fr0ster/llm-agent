import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseDagPlan } from '../llm-dag-planner.js';

// #171 obs 2c used to synthesize a one-node plan from the raw prompt when the
// planner LLM returned no nodes. Spec §10.5.7 C8 removed that fallback: no
// nodes is COORDINATOR_PLAN_INVALID — see llm-dag-planner-no-nodes.test.ts.
describe('parseDagPlan — empty plans', () => {
  it('throws on empty nodes', () => {
    assert.throws(
      () => parseDagPlan('{"nodes":[]}'),
      /Planner returned no nodes/,
    );
  });
});
