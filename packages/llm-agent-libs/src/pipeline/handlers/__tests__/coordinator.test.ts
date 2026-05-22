import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  IDispatchStrategy,
  IPlanningStrategy,
  Plan,
  PlanStep,
  StepResult,
} from '@mcp-abap-adt/llm-agent';
import type { ISpan } from '../../../tracer/types.js';
import type { PipelineContext } from '../../context.js';
import {
  CoordinatorHandler,
  type CoordinatorHandlerDeps,
} from '../coordinator.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSpan(): ISpan {
  return {
    setAttribute() {},
    setStatus() {},
    addEvent() {},
    end() {},
  } as unknown as ISpan;
}

interface EmittedChunk {
  content?: string;
  finishReason?: 'stop' | 'tool_calls' | 'length' | 'error';
}

function makeCtx(partial: Partial<PipelineContext> = {}): {
  ctx: PipelineContext;
  chunks: EmittedChunk[];
} {
  const chunks: EmittedChunk[] = [];
  const ctx = {
    inputText: 'do the thing',
    sessionId: 'test-session',
    assembledMessages: [],
    options: { signal: undefined as AbortSignal | undefined },
    yield(chunk: { ok: boolean; value?: EmittedChunk }) {
      if (chunk.ok && chunk.value) chunks.push(chunk.value);
    },
    ...partial,
  } as unknown as PipelineContext;
  return { ctx, chunks };
}

function makePlan(steps: PlanStep[]): Plan {
  return {
    steps,
    rationale: 'test plan',
    createdAt: Date.now(),
    source: 'planner-llm',
  };
}

function makePlanning(
  initialSteps: PlanStep[],
  opts: {
    onShouldReplan?: (r: StepResult) => boolean;
    rebuiltSteps?: PlanStep[];
  } = {},
): IPlanningStrategy {
  return {
    name: 'fake-planning',
    async buildInitialPlan() {
      return makePlan(initialSteps.map((s) => ({ ...s })));
    },
    shouldReplan(_ctx, r) {
      return opts.onShouldReplan ? opts.onShouldReplan(r) : false;
    },
    async rebuildPlan() {
      return makePlan((opts.rebuiltSteps ?? []).map((s) => ({ ...s })));
    },
  };
}

function makeDispatch(
  perStep: (step: PlanStep) => Partial<StepResult>,
): IDispatchStrategy {
  return {
    name: 'fake-dispatch',
    async dispatch(step) {
      const partial = perStep(step);
      return {
        stepId: step.id,
        output: '',
        durationMs: 1,
        ok: true,
        ...partial,
      };
    },
  };
}

function makeDeps(
  planning: IPlanningStrategy,
  dispatch: IDispatchStrategy,
  overrides: Partial<CoordinatorHandlerDeps> = {},
): CoordinatorHandlerDeps {
  return {
    planning,
    dispatch,
    maxSteps: overrides.maxSteps ?? 8,
    maxRetriesPerStep: overrides.maxRetriesPerStep ?? 0,
    failPolicy: overrides.failPolicy ?? 'abort',
    maxLayer: overrides.maxLayer ?? 8,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CoordinatorHandler', () => {
  it('runs all steps and emits finishReason=stop on success', async () => {
    const planning = makePlanning([
      { id: 's1', goal: 'first', status: 'pending' },
      { id: 's2', goal: 'second', status: 'pending' },
    ]);
    const dispatch = makeDispatch((step) => ({
      output: `out-${step.id}`,
      ok: true,
    }));
    const handler = new CoordinatorHandler(makeDeps(planning, dispatch));
    const { ctx, chunks } = makeCtx();

    const ok = await handler.execute(ctx, {}, makeSpan());

    assert.equal(ok, true);
    assert.equal(chunks.length, 2);
    assert.match(chunks[0].content ?? '', /### s1\nout-s1/);
    assert.match(chunks[0].content ?? '', /### s2\nout-s2/);
    assert.equal(chunks[1].finishReason, 'stop');
    assert.equal(
      ctx.plan?.steps.every((s) => s.status === 'done'),
      true,
    );
  });

  it('runs without subAgents on ctx (SelfDispatch scenario)', async () => {
    const planning = makePlanning([
      { id: 's1', goal: 'self-only', status: 'pending' },
    ]);
    const dispatch = makeDispatch(() => ({ output: 'self-out', ok: true }));
    const handler = new CoordinatorHandler(makeDeps(planning, dispatch));
    // No `subAgents` field — coordinator must normalise to empty Map and not abort.
    const { ctx, chunks } = makeCtx({ subAgents: undefined });

    const ok = await handler.execute(ctx, {}, makeSpan());

    assert.equal(ok, true);
    assert.equal(ctx.error, undefined);
    assert.equal(chunks[1].finishReason, 'stop');
  });

  it('returns finishReason=length when maxSteps is reached with pending work', async () => {
    const planning = makePlanning([
      { id: 's1', goal: 'a', status: 'pending' },
      { id: 's2', goal: 'b', status: 'pending' },
      { id: 's3', goal: 'c', status: 'pending' },
    ]);
    const dispatch = makeDispatch((s) => ({ output: `o-${s.id}`, ok: true }));
    const handler = new CoordinatorHandler(
      makeDeps(planning, dispatch, { maxSteps: 2 }),
    );
    const { ctx, chunks } = makeCtx();

    const ok = await handler.execute(ctx, {}, makeSpan());

    assert.equal(ok, true);
    assert.equal(chunks[1].finishReason, 'length');
    assert.match(
      chunks[0].content ?? '',
      /max steps \(2\) reached, 1 step\(s\) still pending/,
    );
    const remaining =
      ctx.plan?.steps.filter((s) => s.status === 'pending') ?? [];
    assert.equal(remaining.length, 1);
  });

  it('failPolicy=continue surfaces a failure summary and finishes with stop', async () => {
    const planning = makePlanning([
      { id: 's1', goal: 'will-fail', status: 'pending' },
      { id: 's2', goal: 'ok', status: 'pending' },
    ]);
    const dispatch = makeDispatch((s) =>
      s.id === 's1'
        ? { ok: false, output: '', error: 'boom' }
        : { ok: true, output: 'fine' },
    );
    const handler = new CoordinatorHandler(
      makeDeps(planning, dispatch, { failPolicy: 'continue' }),
    );
    const { ctx, chunks } = makeCtx();

    const ok = await handler.execute(ctx, {}, makeSpan());

    assert.equal(ok, true);
    assert.equal(chunks[1].finishReason, 'stop');
    assert.match(
      chunks[0].content ?? '',
      /1 step\(s\) failed under failPolicy=continue/,
    );
  });

  it('failPolicy=abort returns false on first failure', async () => {
    const planning = makePlanning([
      { id: 's1', goal: 'will-fail', status: 'pending' },
    ]);
    const dispatch = makeDispatch(() => ({ ok: false, error: 'nope' }));
    const handler = new CoordinatorHandler(
      makeDeps(planning, dispatch, { failPolicy: 'abort' }),
    );
    const { ctx } = makeCtx();

    const ok = await handler.execute(ctx, {}, makeSpan());

    assert.equal(ok, false);
    assert.ok(ctx.error instanceof Error);
    assert.match(String(ctx.error), /step s1 failed/);
  });
});
