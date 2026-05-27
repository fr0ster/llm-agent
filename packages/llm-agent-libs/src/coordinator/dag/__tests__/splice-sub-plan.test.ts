import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DagPlan } from '@mcp-abap-adt/llm-agent';
import { spliceSubPlan } from '../splice-sub-plan.js';

describe('spliceSubPlan', () => {
  it('replaces a node with a namespaced sub-plan and rewires consumers', () => {
    const plan: DagPlan = {
      nodes: [
        { id: 'X', goal: 'big', needsInput: true },
        { id: 'Y', goal: 'after', dependsOn: ['X'] },
      ],
      createdAt: 0,
    };
    const sub: DagPlan = {
      nodes: [
        { id: 'a', goal: 'step a' },
        { id: 'b', goal: 'step b', dependsOn: ['a'] },
      ],
      createdAt: 0,
    };
    const out = spliceSubPlan(plan, 'X', sub);
    const ids = out.nodes.map((n) => n.id).sort();
    assert.deepEqual(ids, ['X:a', 'X:b', 'Y']);
    const a = out.nodes.find((n) => n.id === 'X:a');
    const b = out.nodes.find((n) => n.id === 'X:b');
    const y = out.nodes.find((n) => n.id === 'Y');
    assert.ok(a && b && y);
    assert.equal(a.needsInput, true);
    assert.deepEqual(a.dependsOn ?? [], []);
    assert.deepEqual(b.dependsOn, ['X:a']);
    assert.deepEqual(y.dependsOn, ['X:b']);
  });

  it('a multi-root sub-plan: every root inherits the replaced node deps', () => {
    const plan: DagPlan = {
      nodes: [
        { id: 'P', goal: 'pre' },
        { id: 'X', goal: 'big', dependsOn: ['P'] },
      ],
      createdAt: 0,
    };
    const sub: DagPlan = {
      nodes: [
        { id: 'r1', goal: 'root1' },
        { id: 'r2', goal: 'root2' },
      ],
      createdAt: 0,
    };
    const out = spliceSubPlan(plan, 'X', sub);
    const r1 = out.nodes.find((n) => n.id === 'X:r1');
    const r2 = out.nodes.find((n) => n.id === 'X:r2');
    assert.ok(r1 && r2);
    assert.deepEqual(r1.dependsOn, ['P']);
    assert.deepEqual(r2.dependsOn, ['P']);
  });
});
