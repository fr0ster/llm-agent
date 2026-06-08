import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  ControllerConfig,
  NextStep,
  PendingMarker,
  SessionBundle,
  SubagentResult,
} from '../types.js';

describe('controller types', () => {
  it('SubagentResult discriminates content|tool_call|error', () => {
    const r: SubagentResult = { kind: 'content', content: 'x' };
    assert.equal(r.kind, 'content');
  });
  it('SessionBundle + PendingMarker + NextStep + ControllerConfig are usable', () => {
    const marker: PendingMarker = {
      kind: 'external-tool',
      extId: 'ext:1',
      toolName: 't',
      args: {},
      position: 'step:0',
    };
    const next: NextStep = {
      kind: 'next',
      step: { name: 's', instructions: 'do' },
    };
    const bundle: SessionBundle = {
      goal: 'g',
      plannerPrivate: '',
      budgets: { stepsUsed: 0, rewindsUsed: 0 },
      pending: marker,
    };
    const cfg: ControllerConfig = {
      subagents: {
        evaluator: { provider: 'openai', apiKey: 'k' },
        planner: { provider: 'openai', apiKey: 'k' },
        executor: { provider: 'openai', apiKey: 'k' },
      },
      targetState: { strategy: 'auto', distanceThreshold: 0.25 },
      sessionMemory: { collection: 'session-memory' },
      budgets: { maxSteps: 20, maxRetries: 3, maxRewinds: 5 },
    };
    assert.equal(next.kind, 'next');
    assert.equal(bundle.budgets.stepsUsed, 0);
    assert.equal(cfg.budgets.maxSteps, 20);
  });
  it('ControllerConfig.planner + SessionBundle.plan/planCursor + planner seam types', () => {
    const cfg: Partial<ControllerConfig> = { planner: 'adaptive' };
    const bundle: SessionBundle = {
      goal: 'g',
      plannerPrivate: '',
      budgets: { stepsUsed: 0, rewindsUsed: 0 },
      plan: [{ name: 's1', instructions: 'do' }],
      planCursor: 0,
    };
    assert.equal(cfg.planner, 'adaptive');
    assert.equal(bundle.plan?.[0].name, 's1');
    assert.equal(bundle.planCursor, 0);
  });
});
