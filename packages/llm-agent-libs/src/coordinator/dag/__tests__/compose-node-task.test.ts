import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DagPlan, PlanNode } from '@mcp-abap-adt/llm-agent';
import { composeNodeTask } from '../compose-node-task.js';

function plan(objective?: string): DagPlan {
  return { nodes: [], objective, createdAt: 0 };
}
function node(o: Partial<PlanNode> = {}): PlanNode {
  return { id: 'n1', goal: 'Summarize', ...o };
}

describe('composeNodeTask', () => {
  it('bare goal when no objective/deps/needsInput', () => {
    assert.equal(composeNodeTask(node(), plan(), 'RAW', {}), 'Summarize');
  });

  it('prepends objective when present', () => {
    const t = composeNodeTask(node(), plan('Ship it'), 'RAW', {});
    assert.match(t, /Task: Summarize/);
    assert.match(t, /Overall objective: Ship it/);
  });

  it('embeds dependency outputs (data-flow along edges)', () => {
    const t = composeNodeTask(node({ dependsOn: ['a', 'b'] }), plan(), 'RAW', {
      a: 'OUT_A',
      b: 'OUT_B',
    });
    assert.match(t, /Input from a:\n---\nOUT_A\n---/);
    assert.match(t, /Input from b:\n---\nOUT_B\n---/);
    assert.doesNotMatch(t, /RAW/);
  });

  it('embeds the original prompt as delimited data when needsInput', () => {
    const t = composeNodeTask(node({ needsInput: true }), plan(), 'RAW', {});
    assert.match(t, /Input \(user-provided data\):\n---\nRAW\n---/);
  });

  it('combines dep outputs and user input when both present', () => {
    const t = composeNodeTask(
      node({ dependsOn: ['a'], needsInput: true }),
      plan(),
      'RAW',
      { a: 'OUT_A' },
    );
    assert.match(t, /Input from a:\n---\nOUT_A\n---/);
    assert.match(t, /Input \(user-provided data\):\n---\nRAW\n---/);
  });

  it('uses empty string when a declared dependency has no output', () => {
    const t = composeNodeTask(node({ dependsOn: ['x'] }), plan(), 'RAW', {});
    assert.match(t, /Input from x:\n---\n\n---/);
  });

  it('renders ancestor clarifications and excludes siblings', () => {
    const p: DagPlan = {
      nodes: [
        { id: 'a', goal: 'A' },
        { id: 'b', goal: 'B', dependsOn: ['a'] },
      ],
      objective: 'O',
      createdAt: 0,
    };
    const task = composeNodeTask(
      p.nodes[1],
      p,
      'RAW',
      { a: 'A-out' },
      {
        objective: 'O',
        clarifications: [{ question: 'which?', answer: 'ZCUST' }],
        oracleObservations: [],
      },
    );
    assert.match(task, /which\?/);
    assert.match(task, /ZCUST/);
    assert.match(task, /A-out/); // dependency output present
    assert.doesNotMatch(task, /sibling/i); // no sibling leakage (there is none to include)
  });
});
