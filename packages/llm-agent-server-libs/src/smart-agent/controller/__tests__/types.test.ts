import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type ControllerConfig,
  MAX_REQUIRE_CHARS,
  MAX_REQUIRES,
  type NextStep,
  type PendingMarker,
  type PlannerKind,
  type SessionBundle,
  type Step,
  type SubagentResult,
  validateRequires,
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
  it('ControllerConfig has no user planner field; PlannerKind is capability-tuned', () => {
    // planner selection is preset-encoded, not a config field (§C clean break).
    const cfg: Partial<ControllerConfig> = {
      subagents: {
        evaluator: { provider: 'openai', apiKey: 'k' },
        planner: { provider: 'openai', apiKey: 'k' },
        executor: { provider: 'openai', apiKey: 'k' },
      },
    } as Partial<ControllerConfig>;
    // @ts-expect-error — `planner` is no longer a ControllerConfig field
    cfg.planner;
    const kind: PlannerKind = 'weak-executor';
    assert.equal(kind, 'weak-executor');
  });
});

describe('Step', () => {
  it('Step carries stable stepId + optional discovery/supersedes', () => {
    const s: Step = {
      stepId: 's1',
      name: 'Fetch',
      instructions: 'read it',
      discovery: true,
      supersedesStepId: 's0',
    };
    assert.equal(s.stepId, 's1');
    assert.equal(s.discovery, true);
    assert.equal(s.supersedesStepId, 's0');
  });
});

describe('validateRequires', () => {
  it('undefined / [] → undefined (no deps)', () => {
    assert.equal(validateRequires(undefined), undefined);
    assert.equal(validateRequires([]), undefined);
  });
  it('trims valid string entries', () => {
    assert.deepEqual(validateRequires(['  table T100  ', 'domain ZD']), [
      'table T100',
      'domain ZD',
    ]);
  });
  it('malformed → false (non-string, empty, oversized entry, too many)', () => {
    assert.equal(validateRequires([123]), false);
    assert.equal(validateRequires(['']), false);
    assert.equal(validateRequires(['x'.repeat(MAX_REQUIRE_CHARS + 1)]), false);
    assert.equal(
      validateRequires(Array.from({ length: MAX_REQUIRES + 1 }, () => 'r')),
      false,
    );
    assert.equal(validateRequires('not-an-array'), false);
  });
});
