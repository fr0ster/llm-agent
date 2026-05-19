import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ICoordinatorContext, ISkillMeta } from '@mcp-abap-adt/llm-agent';
import { SkillStepsPlanning } from '../skill-steps.js';

function makeCtx(activeSkillMeta?: ISkillMeta): ICoordinatorContext {
  return {
    inputText: 'x',
    registry: new Map(),
    stepResults: {},
    sessionId: 'test',
    activeSkillMeta,
  } as unknown as ICoordinatorContext;
}

describe('SkillStepsPlanning', () => {
  it('builds a plan from ctx.activeSkillMeta.steps without a resolver argument', async () => {
    const meta: ISkillMeta = {
      name: 'create-and-test',
      description: 'two-step process',
      steps: [
        { id: 'create', goal: 'Create the program' },
        {
          id: 'test',
          goal: 'Run the smoke test',
          expectedTools: ['RuntimeRunProgram'],
        },
      ],
    };
    const strategy = new SkillStepsPlanning();
    const plan = await strategy.buildInitialPlan(makeCtx(meta));
    assert.equal(plan.steps.length, 2);
    assert.equal(plan.steps[0].id, 'create');
    assert.equal(plan.steps[1].expectedTools?.[0], 'RuntimeRunProgram');
    assert.equal(plan.source, 'skill-steps');
    assert.match(plan.rationale ?? '', /create-and-test/);
  });

  it('throws when no active skill with steps is present', async () => {
    const strategy = new SkillStepsPlanning();
    await assert.rejects(
      () => strategy.buildInitialPlan(makeCtx(undefined)),
      /no active skill with structured 'steps:' found/,
    );
  });

  it('custom resolver takes precedence over ctx.activeSkillMeta', async () => {
    const ctxMeta: ISkillMeta = {
      name: 'from-ctx',
      description: '',
      steps: [{ id: 'a', goal: 'should not appear' }],
    };
    const resolverMeta: ISkillMeta = {
      name: 'from-resolver',
      description: '',
      steps: [{ id: 'b', goal: 'resolver wins' }],
    };
    const strategy = new SkillStepsPlanning(() => resolverMeta);
    const plan = await strategy.buildInitialPlan(makeCtx(ctxMeta));
    assert.equal(plan.steps[0].goal, 'resolver wins');
  });

  it('shouldReplan always returns false (single-pass strategy)', async () => {
    const strategy = new SkillStepsPlanning();
    const result = strategy.shouldReplan(makeCtx(), {
      stepId: 's',
      output: '',
      ok: false,
      durationMs: 0,
    });
    assert.equal(result, false);
  });
});
