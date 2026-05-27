import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  EpicFailTrace,
  IDispatchStrategy,
  IPlanningStrategy,
  ISubAgent,
  ISubAgentInput,
  Plan,
  PlanStep,
} from '@mcp-abap-adt/llm-agent';
import { SubAgentDispatch } from '../../../coordinator/dispatch/subagent.js';
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

class EpicFailingSubAgent implements ISubAgent {
  readonly name = 'failer';
  readonly capabilities = {
    contextPolicy: 'optional' as const,
  };
  async run(_input: ISubAgentInput) {
    const trace: EpicFailTrace = {
      stepId: 'inner-step',
      agentName: 'inner-failer',
      attempts: [],
      originalError: 'unrecoverable inner error',
    };
    return {
      output: '',
      errorClass: 'epicfail' as const,
      epicFailTrace: trace,
    };
  }
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

function makeCtx(subAgents: Map<string, ISubAgent>): PipelineContext {
  return {
    inputText: 'top',
    sessionId: 's',
    assembledMessages: [],
    options: { signal: undefined },
    subAgents,
    yield() {},
  } as unknown as PipelineContext;
}

describe('Coordinator epicfail propagation', () => {
  it('marks the step ok=false with the child trace surfaced and stops the plan', async () => {
    const failer = new EpicFailingSubAgent();
    const subAgents = new Map<string, ISubAgent>([['failer', failer]]);
    const planning = makePlanning([
      { id: 's1', goal: 'attempt', agent: 'failer', status: 'pending' },
      { id: 's2', goal: 'after', agent: 'failer', status: 'pending' },
    ]);
    const dispatch: IDispatchStrategy = new SubAgentDispatch();
    const deps: CoordinatorHandlerDeps = {
      planning,
      dispatch,
      maxSteps: 5,
      maxRetriesPerStep: 0,
      failPolicy: 'abort',
    };
    const handler = new CoordinatorHandler(deps);
    const ctx = makeCtx(subAgents);

    const ok = await handler.execute(ctx, {}, makeSpan());

    assert.equal(ok, false);
    const s1 = ctx.stepResults?.s1;
    assert.ok(s1);
    assert.equal(s1?.ok, false);
    assert.match(String(s1?.error ?? ''), /epicfail/i);
    assert.ok(s1?.epicFailTrace, 'step result must carry the epicFailTrace');
    // s2 must NOT have been dispatched (abort on epicfail)
    assert.equal(ctx.stepResults?.s2, undefined);
  });
});
