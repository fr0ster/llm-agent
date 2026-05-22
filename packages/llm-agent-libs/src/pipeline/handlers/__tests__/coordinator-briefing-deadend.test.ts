import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  IPlanningStrategy,
  ISubAgent,
  ISubAgentInput,
  ISubAgentResult,
  Plan,
  PlanStep,
  StepResult,
  SubAgentRegistry,
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

class ScriptedSubAgent implements ISubAgent {
  readonly name = 'worker';
  readonly description = 'records briefing on second call';
  callIndex = 0;
  secondInput?: ISubAgentInput;
  async run(input: ISubAgentInput): Promise<ISubAgentResult> {
    this.callIndex++;
    if (this.callIndex === 1) {
      throw new Error('grep produced no matches');
    }
    this.secondInput = input;
    return { output: 'done' };
  }
}

function makePlan(steps: PlanStep[]): Plan {
  return {
    steps,
    rationale: 'deadend test',
    createdAt: Date.now(),
    source: 'planner-llm',
  };
}

function makePlanning(steps: PlanStep[]): IPlanningStrategy {
  return {
    name: 'scripted-planning',
    async buildInitialPlan() {
      return makePlan(steps.map((s) => ({ ...s })));
    },
    shouldReplan(_ctx, _r: StepResult) {
      return false;
    },
    async rebuildPlan() {
      return makePlan([]);
    },
  };
}

interface EmittedChunk {
  content?: string;
  finishReason?: 'stop' | 'tool_calls' | 'length' | 'error';
}

function makeCtx(subAgents: SubAgentRegistry): {
  ctx: PipelineContext;
  chunks: EmittedChunk[];
} {
  const chunks: EmittedChunk[] = [];
  const ctx = {
    inputText: 'find FOO in the repo',
    sessionId: 'sess-1',
    assembledMessages: [],
    options: { signal: undefined as AbortSignal | undefined },
    subAgents,
    yield(chunk: { ok: boolean; value?: EmittedChunk }) {
      if (chunk.ok && chunk.value) chunks.push(chunk.value);
    },
  } as unknown as PipelineContext;
  return { ctx, chunks };
}

describe('Coordinator briefing dead-end propagation', () => {
  it('passes the failed step into the next step briefing.tried', async () => {
    const worker = new ScriptedSubAgent();
    const registry: SubAgentRegistry = new Map([['worker', worker]]);
    const planning = makePlanning([
      {
        id: 's1',
        goal: 'Grep src/ for FOO',
        agent: 'worker',
        status: 'pending',
      },
      {
        id: 's2',
        goal: 'Find FOO another way',
        agent: 'worker',
        status: 'pending',
      },
    ]);
    const deps: CoordinatorHandlerDeps = {
      planning,
      dispatch: new SubAgentDispatch(),
      maxSteps: 5,
      maxRetriesPerStep: 0,
      failPolicy: 'continue',
    };
    const handler = new CoordinatorHandler(deps);
    const { ctx } = makeCtx(registry);

    await handler.execute(ctx, {}, makeSpan());

    assert.equal(worker.callIndex, 2, 'second step should have run');
    assert.ok(worker.secondInput, 'second call must have captured input');
    assert.equal(worker.secondInput?.task, 'Find FOO another way');
    assert.deepEqual(worker.secondInput?.briefing?.tried, [
      's1 (Grep src/ for FOO) — failed: grep produced no matches',
    ]);
  });
});
