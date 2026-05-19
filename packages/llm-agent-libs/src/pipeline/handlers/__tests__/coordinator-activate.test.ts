import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IActivationStrategy, ISkill } from '@mcp-abap-adt/llm-agent';
import {
  AutoActivation,
  ExplicitActivation,
} from '../../../coordinator/index.js';
import type { ISpan } from '../../../tracer/types.js';
import type { PipelineContext } from '../../context.js';
import { CoordinatorActivateHandler } from '../coordinator-activate.js';

function makeSpan(): ISpan {
  return {
    setAttribute() {},
    setStatus() {},
    addEvent() {},
    end() {},
  } as unknown as ISpan;
}

function makeCtx(partial: Partial<PipelineContext> = {}): PipelineContext {
  return {
    selectedSkills: [],
    options: { sessionLogger: undefined },
    ...partial,
  } as unknown as PipelineContext;
}

function makeSkillWithSteps(): ISkill {
  return {
    name: 'multi-step-skill',
    description: 'has steps',
    meta: {
      name: 'multi-step-skill',
      description: 'has steps',
      steps: [{ id: 's1', goal: 'a' }],
    },
  } as unknown as ISkill;
}

function makeSkillNoSteps(): ISkill {
  return {
    name: 'flat-skill',
    description: 'no steps',
    meta: { name: 'flat-skill', description: 'no steps' },
  } as unknown as ISkill;
}

describe('CoordinatorActivateHandler', () => {
  it('ExplicitActivation always sets coordinatorActive=true', async () => {
    const handler = new CoordinatorActivateHandler(new ExplicitActivation());
    const ctx = makeCtx();
    const ok = await handler.execute(ctx, {}, makeSpan());
    assert.equal(ok, true);
    assert.equal(ctx.coordinatorActive, true);
  });

  it('AutoActivation: no subagents + no structured skill → false', async () => {
    const handler = new CoordinatorActivateHandler(new AutoActivation());
    const ctx = makeCtx({ selectedSkills: [] });
    await handler.execute(ctx, {}, makeSpan());
    assert.equal(ctx.coordinatorActive, false);
  });

  it('AutoActivation: subagents present → true', async () => {
    const handler = new CoordinatorActivateHandler(new AutoActivation());
    const registry = new Map();
    registry.set('worker', { name: 'worker' });
    const ctx = makeCtx({ subAgents: registry, selectedSkills: [] });
    await handler.execute(ctx, {}, makeSpan());
    assert.equal(ctx.coordinatorActive, true);
  });

  it('AutoActivation: structured skill (with steps) → true', async () => {
    const handler = new CoordinatorActivateHandler(new AutoActivation());
    const ctx = makeCtx({ selectedSkills: [makeSkillWithSteps()] });
    await handler.execute(ctx, {}, makeSpan());
    assert.equal(ctx.coordinatorActive, true);
  });

  it('AutoActivation: skill without steps → false', async () => {
    const handler = new CoordinatorActivateHandler(new AutoActivation());
    const ctx = makeCtx({ selectedSkills: [makeSkillNoSteps()] });
    await handler.execute(ctx, {}, makeSpan());
    assert.equal(ctx.coordinatorActive, false);
  });

  it('custom strategy can observe both signals via ctx params', async () => {
    let observed: {
      hasSubAgents: boolean;
      hasStructuredSkill: boolean;
    } | null = null;
    const custom: IActivationStrategy = {
      name: 'custom',
      shouldActivate(c) {
        observed = c;
        return c.hasSubAgents && c.hasStructuredSkill;
      },
    };
    const handler = new CoordinatorActivateHandler(custom);
    const registry = new Map();
    registry.set('w', { name: 'w' });
    const ctx = makeCtx({
      subAgents: registry,
      selectedSkills: [makeSkillWithSteps()],
    });
    await handler.execute(ctx, {}, makeSpan());
    assert.deepEqual(observed, {
      hasSubAgents: true,
      hasStructuredSkill: true,
    });
    assert.equal(ctx.coordinatorActive, true);
  });
});
