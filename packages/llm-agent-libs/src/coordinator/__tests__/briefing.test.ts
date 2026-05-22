import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  ICoordinatorContext,
  PlanStep,
  StepResult,
} from '@mcp-abap-adt/llm-agent';
import { buildBriefingFromContext } from '../briefing.js';

function step(id: string, goal: string, agent?: string): PlanStep {
  return { id, goal, agent, status: 'pending' };
}

function result(
  stepId: string,
  output: string,
  ok: boolean,
  error?: string,
): StepResult {
  return { stepId, output, durationMs: 1, ok, error };
}

function ctx(
  stepResults: Record<string, StepResult>,
  plan: PlanStep[] = [],
): ICoordinatorContext {
  return {
    inputText: 'top-level user request',
    registry: new Map(),
    stepResults,
    sessionId: 'sess-1',
    plan: { steps: plan, createdAt: 0, source: 'manual' },
  } as unknown as ICoordinatorContext;
}

describe('buildBriefingFromContext', () => {
  it('sets goal to step.goal and copies inputText as the top-level goal-context', () => {
    const s = step('s1', 'Find the failing assertion');
    const b = buildBriefingFromContext(s, ctx({}, [s]));
    assert.equal(b.goal, 'top-level user request');
    assert.deepEqual(b.known, []);
    assert.deepEqual(b.tried, []);
  });

  it('puts successful prior step outputs into known[]', () => {
    const s1 = step('s1', 'Locate test file');
    const s2 = step('s2', 'Read the assertion');
    const b = buildBriefingFromContext(
      s2,
      ctx(
        {
          s1: result('s1', 'Found in tests/foo.test.ts', true),
        },
        [s1, s2],
      ),
    );
    assert.deepEqual(b.known, [
      's1 (Locate test file): Found in tests/foo.test.ts',
    ]);
    assert.deepEqual(b.tried, []);
  });

  it('puts failed prior steps into tried[] with error', () => {
    const s1 = step('s1', 'Grep for setCookie in src/');
    const s2 = step('s2', 'Read auth middleware');
    const b = buildBriefingFromContext(
      s2,
      ctx(
        {
          s1: result('s1', '', false, 'no matches'),
        },
        [s1, s2],
      ),
    );
    assert.deepEqual(b.tried, [
      's1 (Grep for setCookie in src/) — failed: no matches',
    ]);
    assert.deepEqual(b.known, []);
  });

  it('treats successful steps with empty output as dead-ends, not knowns', () => {
    const s1 = step('s1', 'Search for FOO');
    const s2 = step('s2', 'Next thing');
    const b = buildBriefingFromContext(
      s2,
      ctx(
        {
          s1: result('s1', '   ', true),
        },
        [s1, s2],
      ),
    );
    assert.deepEqual(b.tried, [
      's1 (Search for FOO) — completed but produced no usable output',
    ]);
    assert.deepEqual(b.known, []);
  });

  it('truncates long step output in known[] to keep briefing compact', () => {
    const s1 = step('s1', 'Long step');
    const s2 = step('s2', 'Next');
    const longOut = 'x'.repeat(800);
    const b = buildBriefingFromContext(
      s2,
      ctx({ s1: result('s1', longOut, true) }, [s1, s2]),
    );
    // 300-char truncation + ellipsis
    assert.ok(b.known?.[0]?.includes('…'));
    assert.ok((b.known?.[0]?.length ?? 0) < 400);
  });

  it('does not include the current step itself in known/tried', () => {
    const s1 = step('s1', 'Self');
    const b = buildBriefingFromContext(
      s1,
      ctx({ s1: result('s1', 'should not appear', true) }, [s1]),
    );
    assert.deepEqual(b.known, []);
    assert.deepEqual(b.tried, []);
  });
});
