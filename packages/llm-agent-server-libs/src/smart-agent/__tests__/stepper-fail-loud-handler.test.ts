/**
 * Spec §10.5.7 C1–C7 at the handler level: a failing store or planner LLM
 * inside the Stepper reaches the consumer through StepperCoordinatorHandler
 * and DefaultPipeline as COORDINATOR_PLAN_FAILED / COORDINATOR_STEP_FAILED
 * (Task 4F's path: a thrown OrchestratorError keeps its code).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type IExecutor,
  type IStepperPlanner,
  LlmError,
  RagError,
  TokenLedger,
} from '@mcp-abap-adt/llm-agent';
import {
  DefaultPipeline,
  LlmStepperPlanner,
  LlmTaskFormalizer,
  SmartAgent,
  StaticPlanner,
  Stepper,
  StepperInterpreter,
} from '@mcp-abap-adt/llm-agent-libs';
import { makeDefaultDeps } from '@mcp-abap-adt/llm-agent-libs/testing';
import { StepperCoordinatorHandler } from '../stepper-coordinator-handler.js';

const ZERO = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

function knowledge(over: Record<string, unknown> = {}) {
  return {
    async query() {
      return [];
    },
    async list() {
      return [];
    },
    async write() {},
    fingerprint() {
      return '';
    },
    ...over,
  };
}

const okTools = {
  async query() {
    return [];
  },
  lookup() {
    return undefined;
  },
};

function agentWith(opts: {
  planner: IStepperPlanner;
  knowledgeRag?: unknown;
  toolsRag?: unknown;
  taskFormalizer?: LlmTaskFormalizer;
  executed?: string[];
}) {
  const executor: IExecutor = {
    name: 'e',
    async execute(input) {
      opts.executed?.push(input.prompt);
      return { status: 'ok', usage: ZERO };
    },
  };
  let n = 0;
  const rootStepper = new Stepper({
    name: 'root',
    planner: opts.planner,
    interpreter: new StepperInterpreter(),
    executor,
    childSteppers: new Map(),
    reviewerAtDepths: new Set<number>(),
    depth: 0,
    maxParallelSteps: 4,
    mintStepperId: () => `s${n++}`,
  });
  const handler = new StepperCoordinatorHandler({
    buildBuilt: async () =>
      ({
        rootStepper,
        finalizer: {
          async finalize() {
            throw new Error('finalizer must not run');
          },
        },
        budget: { depthRemaining: 1, tokens: new TokenLedger(100000) },
        maxParallelSteps: 4,
        ...(opts.taskFormalizer ? { taskFormalizer: opts.taskFormalizer } : {}),
      }) as never,
    knowledgeRagFor: async () => (opts.knowledgeRag ?? knowledge()) as never,
    toolsRag: (opts.toolsRag ?? okTools) as never,
    mintStepperId: () => 'root',
    mintTurnId: () => 'turn-1',
  });
  const { deps } = makeDefaultDeps();
  const pipeline = new DefaultPipeline({ stepperCoordinator: handler });
  pipeline.initialize({
    ...deps,
    agentConfig: { maxIterations: 3 },
  } as never);
  return new SmartAgent(
    { ...deps, pipeline } as never,
    {
      maxIterations: 3,
    } as never,
  );
}

const planLlm = {
  name: 'stub',
  async chat() {
    return {
      ok: true as const,
      value: { content: '{"nodes":[{"id":"a","goal":"x"}]}' },
    };
  },
};

describe('stepper fail loud — through StepperCoordinatorHandler + DefaultPipeline', () => {
  it('C2 a failing tools store in the planner → COORDINATOR_PLAN_FAILED', async () => {
    const r = await agentWith({
      planner: new LlmStepperPlanner(planLlm as never),
      toolsRag: {
        async query(): Promise<never> {
          throw new RagError('tools store down', 'RAG_UPSTREAM_ERROR');
        },
        lookup() {
          return undefined;
        },
      },
    }).process('review program X');
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'COORDINATOR_PLAN_FAILED');
    assert.match(r.error.message, /RAG_UPSTREAM_ERROR: tools store down/);
  });

  it('C7 a failing formalizer LLM → COORDINATOR_PLAN_FAILED', async () => {
    const r = await agentWith({
      planner: new LlmStepperPlanner(planLlm as never),
      taskFormalizer: new LlmTaskFormalizer({
        async chat() {
          return { ok: false as const, error: new LlmError('quota') };
        },
      } as never),
    }).process('review program X');
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'COORDINATOR_PLAN_FAILED');
    assert.match(r.error.message, /task formalizer.*quota/);
  });

  it('C1 a failing knowledge store list → COORDINATOR_STEP_FAILED; the dependent step does not run', async () => {
    const executed: string[] = [];
    const r = await agentWith({
      planner: new StaticPlanner([
        { id: 'a', goal: 'gather' },
        { id: 'b', goal: 'analyse', dependsOn: ['a'] },
      ]),
      knowledgeRag: knowledge({
        async list(): Promise<never> {
          throw new RagError('store down', 'RAG_UPSTREAM_ERROR');
        },
      }),
      executed,
    }).process('review program X');
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'COORDINATOR_STEP_FAILED');
    assert.match(r.error.message, /node 'b'.*store down/);
    assert.equal(executed.length, 1);
    assert.match(executed[0], /gather/);
  });
});
