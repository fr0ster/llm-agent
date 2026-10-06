/**
 * Spec §10.5.12 U5, §13 B13 — HybridDispatch keeps its fallback dispatcher for
 * a step that names no agent; a step that NAMES an agent the registry lacks is
 * a failed step, never silently run by the fallback.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  ICoordinatorContext,
  IDispatchStrategy,
  IPlanningStrategy,
  ISubAgent,
  PlanStep,
  StepResult,
} from '@mcp-abap-adt/llm-agent';
import { SmartAgent } from '../../../agent.js';
import { DefaultPipeline } from '../../../pipeline/default-pipeline.js';
import { makeDefaultDeps } from '../../../testing/index.js';
import { HybridDispatch } from '../hybrid.js';

function recording(name: string): IDispatchStrategy & { steps: string[] } {
  const steps: string[] = [];
  return {
    name,
    steps,
    async dispatch(step: PlanStep): Promise<StepResult> {
      steps.push(step.id);
      return {
        stepId: step.id,
        output: `${name}:${step.id}`,
        durationMs: 1,
        ok: true,
      };
    },
  };
}

const coder: ISubAgent = {
  name: 'coder',
  description: 'writes code',
  async run() {
    return { output: 'code' };
  },
};

function ctxWith(): ICoordinatorContext {
  return {
    inputText: 'x',
    registry: new Map([['coder', coder]]),
    stepResults: {},
    sessionId: 's',
  };
}

const step = (id: string, agent?: string): PlanStep => ({
  id,
  goal: `goal ${id}`,
  status: 'pending',
  ...(agent ? { agent } : {}),
});

describe('U5 HybridDispatch', () => {
  it('a step with no agent → the fallback dispatcher (pinned)', async () => {
    const primary = recording('primary');
    const fallback = recording('fallback');
    const r = await new HybridDispatch(primary, fallback).dispatch(
      step('s1'),
      ctxWith(),
    );
    assert.ok(r.ok);
    assert.deepEqual(fallback.steps, ['s1']);
    assert.deepEqual(primary.steps, []);
  });

  it("agent: 'coder' (registered) → the primary dispatcher (pinned)", async () => {
    const primary = recording('primary');
    const fallback = recording('fallback');
    const r = await new HybridDispatch(primary, fallback).dispatch(
      step('s1', 'coder'),
      ctxWith(),
    );
    assert.ok(r.ok);
    assert.deepEqual(primary.steps, ['s1']);
    assert.deepEqual(fallback.steps, []);
  });

  it("agent: 'ghost' (not registered) → a failed step naming both; neither dispatcher runs", async () => {
    const primary = recording('primary');
    const fallback = recording('fallback');
    const r = await new HybridDispatch(primary, fallback).dispatch(
      step('s1', 'ghost'),
      ctxWith(),
    );
    assert.equal(r.ok, false);
    assert.equal(r.stepId, 's1');
    assert.equal(r.output, '');
    assert.match(r.error ?? '', /ghost/);
    assert.match(r.error ?? '', /coder/);
    assert.deepEqual(primary.steps, []);
    assert.deepEqual(fallback.steps, []);
  });

  it("an empty registry names 'none'", async () => {
    const r = await new HybridDispatch(
      recording('primary'),
      recording('fallback'),
    ).dispatch(step('s1', 'ghost'), { ...ctxWith(), registry: new Map() });
    assert.equal(
      r.error,
      "HybridDispatch: agent 'ghost' not in registry (registered: none)",
    );
  });
});

describe('U5 through CoordinatorHandler (DefaultPipeline)', () => {
  function planning(steps: PlanStep[]): IPlanningStrategy {
    return {
      name: 'fixed',
      async buildInitialPlan() {
        return {
          steps: steps.map((s) => ({ ...s })),
          createdAt: 0,
          source: 'manual',
        };
      },
      shouldReplan() {
        return false;
      },
      async rebuildPlan() {
        throw new Error('not used');
      },
    };
  }

  function agentFor(failPolicy: 'abort' | 'continue', steps: PlanStep[]) {
    const primary = recording('primary');
    const fallback = recording('fallback');
    const { deps } = makeDefaultDeps();
    const pipeline = new DefaultPipeline({
      subAgents: new Map([['coder', coder]]),
      coordinator: {
        planning: planning(steps),
        dispatch: new HybridDispatch(primary, fallback),
        failPolicy,
        maxRetriesPerStep: 0,
      },
    });
    pipeline.initialize({
      ...deps,
      agentConfig: { maxIterations: 3 },
    } as never);
    const agent = new SmartAgent(
      { ...deps, pipeline } as never,
      {
        maxIterations: 3,
      } as never,
    );
    return { agent, primary, fallback };
  }

  it("failPolicy 'abort' + a step naming 'ghost' → the consumer receives COORDINATOR_STEP_FAILED", async () => {
    const { agent, primary, fallback } = agentFor('abort', [
      step('s1', 'ghost'),
      step('s2'),
    ]);
    const r = await agent.process('do it');
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'COORDINATOR_STEP_FAILED');
    assert.match(r.error.message, /ghost/);
    assert.deepEqual(fallback.steps, []);
    assert.deepEqual(primary.steps, []);
  });

  it("failPolicy 'continue' → the answer carries the failed-step note (pinned)", async () => {
    const { agent, fallback } = agentFor('continue', [
      step('s1', 'ghost'),
      step('s2'),
    ]);
    const r = await agent.process('do it');
    assert.ok(r.ok);
    assert.match(
      r.value.content,
      /\[Coordinator: 1 step\(s\) failed under failPolicy=continue\.\]/,
    );
    assert.deepEqual(fallback.steps, ['s2']);
  });
});
