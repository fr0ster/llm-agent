import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ICoordinatorContext, PlanStep } from '@mcp-abap-adt/llm-agent';
import { composeTask } from '../compose-task.js';

function ctx(
  overrides: Partial<ICoordinatorContext> = {},
): ICoordinatorContext {
  return {
    inputText: 'RAW USER REQUEST',
    registry: new Map(),
    stepResults: {},
    sessionId: 't',
    ...overrides,
  } as unknown as ICoordinatorContext;
}

function step(overrides: Partial<PlanStep> = {}): PlanStep {
  return { id: 's1', goal: 'Summarize it', status: 'pending', ...overrides };
}

describe('composeTask', () => {
  it('returns bare goal when no objective, needsInput, or inputTemplate', () => {
    const task = composeTask(step(), ctx());
    assert.equal(task, 'Summarize it');
  });

  it('prepends the plan objective when present', () => {
    const c = ctx({
      plan: { steps: [], objective: 'Ship the release', createdAt: 0, source: 'planner-llm' },
    });
    const task = composeTask(step(), c);
    assert.match(task, /Task: Summarize it/);
    assert.match(task, /Overall objective: Ship the release/);
  });

  it('embeds inputText verbatim as delimited data when needsInput is true', () => {
    const task = composeTask(step({ needsInput: true }), ctx());
    assert.match(task, /Input \(user-provided data\):/);
    assert.match(task, /---\nRAW USER REQUEST\n---/);
  });

  it('does not include inputText when needsInput is false', () => {
    const task = composeTask(step({ needsInput: false }), ctx());
    assert.doesNotMatch(task, /RAW USER REQUEST/);
  });

  it('inputTemplate overrides and expands {{...}} placeholders', () => {
    const c = ctx({
      plan: { steps: [], objective: 'OBJ', createdAt: 0, source: 'planner-llm' },
    });
    const task = composeTask(
      step({ inputTemplate: '{{goal}} || {{objective}} || {{inputText}}' }),
      c,
    );
    assert.equal(task, 'Summarize it || OBJ || RAW USER REQUEST');
  });
});
