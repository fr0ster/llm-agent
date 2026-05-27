import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  IDispatchStrategy,
  IPlanningStrategy,
  ISubAgent,
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

function makeSpan(): ISpan {
  return {
    setAttribute() {},
    setStatus() {},
    addEvent() {},
    end() {},
  } as unknown as ISpan;
}

function makeSubAgent(name: string): ISubAgent {
  return {
    name,
    capabilities: {
      contextPolicy: 'optional',
    },
    async run() {
      return { output: 'ok' };
    },
  };
}

function makePlanning(steps: PlanStep[]): IPlanningStrategy {
  return {
    name: 'fake',
    async buildInitialPlan() {
      return {
        steps: steps.map((s) => ({ ...s })),
        rationale: 'test',
        createdAt: 0,
        source: 'manual',
      } as Plan;
    },
    shouldReplan() {
      return false;
    },
    async rebuildPlan() {
      return { steps: [], rationale: '', createdAt: 0, source: 'manual' };
    },
  };
}

function makeDispatch(): IDispatchStrategy {
  return {
    name: 'fake-dispatch',
    async dispatch(step: PlanStep): Promise<StepResult> {
      return {
        stepId: step.id,
        output: `out-${step.id}`,
        ok: true,
        durationMs: 1,
      };
    },
  };
}

function makeCtx(opts: { layer: number; subAgents: Map<string, ISubAgent> }): {
  ctx: PipelineContext;
  chunks: Array<{ content?: string }>;
} {
  const chunks: Array<{ content?: string }> = [];
  const ctx = {
    inputText: 'do',
    sessionId: 't',
    layer: opts.layer,
    assembledMessages: [],
    options: { signal: undefined },
    subAgents: opts.subAgents,
    yield(chunk: { ok: boolean; value?: { content?: string } }) {
      if (chunk.ok && chunk.value) chunks.push(chunk.value);
    },
  } as unknown as PipelineContext;
  return { ctx, chunks };
}

function makeDeps(
  planning: IPlanningStrategy,
  dispatch: IDispatchStrategy,
  maxLayer: number,
): CoordinatorHandlerDeps {
  return {
    planning,
    dispatch,
    maxSteps: 8,
    maxRetriesPerStep: 0,
    failPolicy: 'abort',
    maxLayer,
  };
}

describe('CoordinatorHandler layer validation', () => {
  it('allows subagents at layer 0', async () => {
    const subAgents = new Map<string, ISubAgent>([
      ['worker', makeSubAgent('worker')],
    ]);
    const planning = makePlanning([
      { id: 's1', goal: 'g', agent: 'worker', status: 'pending' },
    ]);
    const { ctx } = makeCtx({ layer: 0, subAgents });
    const handler = new CoordinatorHandler(
      makeDeps(planning, makeDispatch(), 1),
    );
    const ok = await handler.execute(ctx, {}, makeSpan());
    assert.equal(ok, true);
    assert.equal(ctx.error, undefined);
  });

  it('allows subagents at layer 1 when maxLayer=2', async () => {
    const subAgents = new Map<string, ISubAgent>([
      ['worker', makeSubAgent('worker')],
    ]);
    const planning = makePlanning([
      { id: 's1', goal: 'g', agent: 'worker', status: 'pending' },
    ]);
    const { ctx } = makeCtx({ layer: 1, subAgents });
    const handler = new CoordinatorHandler(
      makeDeps(planning, makeDispatch(), 2),
    );
    const ok = await handler.execute(ctx, {}, makeSpan());
    assert.equal(ok, true);
    assert.equal(ctx.error, undefined);
  });

  it('rejects any dispatch when layer >= maxLayer', async () => {
    const subAgents = new Map<string, ISubAgent>([
      ['worker', makeSubAgent('worker')],
    ]);
    const planning = makePlanning([
      { id: 's1', goal: 'g', agent: 'worker', status: 'pending' },
    ]);
    const { ctx } = makeCtx({ layer: 2, subAgents });
    const handler = new CoordinatorHandler(
      makeDeps(planning, makeDispatch(), 2),
    );
    const ok = await handler.execute(ctx, {}, makeSpan());
    assert.equal(ok, false);
    assert.ok(ctx.error);
    assert.match(
      String(ctx.error?.message ?? ''),
      /maxLayer|depth limit|cannot dispatch/i,
    );
  });
});
