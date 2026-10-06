/**
 * Spec §10.5.7 C1–C7, §13 B6 — a failing store, classifier or LLM section in
 * the stepper fails the step or the plan with the coordinator's code. No
 * omitted prompt section, no dependent step run without its prerequisites, no
 * live re-fetch in place of the store, no "no need", no raw-prompt task spec.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type DagPlan,
  type IExecutor,
  LlmError,
  OrchestratorError,
  RagError,
  TokenLedger,
} from '@mcp-abap-adt/llm-agent';
import { CyclicReActExecutor } from '../cyclic-react-executor.js';
import { LlmEvaluator } from '../llm-evaluator.js';
import { LlmStepperPlanner } from '../llm-stepper-planner.js';
import { LlmTaskFormalizer } from '../llm-task-formalizer.js';
import { LlmNeedResolver } from '../need-resolver.js';
import { StepperInterpreter } from '../stepper-interpreter.js';

const ZERO = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
const identity = {
  traceId: 't',
  turnId: 'u',
  sessionId: 's',
  stepperId: 'n0',
};

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

const failingTools = {
  async query(): Promise<never> {
    throw new RagError('tools store down', 'RAG_UPSTREAM_ERROR');
  },
  lookup() {
    return undefined;
  },
};

function llm(content: string) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    obj: {
      name: 'stub',
      async chat() {
        calls++;
        return { ok: true as const, value: { content } };
      },
    },
  };
}

const llmDown = {
  name: 'stub',
  async chat() {
    return { ok: false as const, error: new LlmError('quota', 'LLM_ERROR') };
  },
};

const llmRejects = {
  name: 'stub',
  async chat(): Promise<never> {
    throw new LlmError('socket hang up', 'LLM_ERROR');
  },
};

function isCoordinatorError(code: string, pattern: RegExp) {
  return (e: unknown) =>
    e instanceof OrchestratorError &&
    e.code === code &&
    pattern.test(e.message);
}

describe('C1 stepper interpreter — knowledgeRag.list throws', () => {
  it('the step fails and the dependent step is not run', async () => {
    const executed: string[] = [];
    const exec: IExecutor = {
      name: 'e',
      async execute(input) {
        executed.push(input.prompt);
        return { status: 'ok', usage: ZERO };
      },
    };
    const plan: DagPlan = {
      nodes: [
        { id: 'a', goal: 'gather' },
        { id: 'b', goal: 'analyse', dependsOn: ['a'] },
      ],
      createdAt: 0,
    };
    let n = 0;
    await assert.rejects(
      () =>
        new StepperInterpreter().interpret(plan, {
          prompt: 'p',
          knowledgeRag: knowledge({
            async list(): Promise<never> {
              throw new RagError('store down', 'RAG_UPSTREAM_ERROR');
            },
          }) as never,
          toolsRag: okTools as never,
          childSteppers: new Map(),
          executor: exec,
          budget: { depthRemaining: 3, tokens: new TokenLedger(100000) },
          identity,
          maxParallelSteps: 4,
          mintStepperId: () => `s${n++}`,
        }),
      isCoordinatorError(
        'COORDINATOR_STEP_FAILED',
        /node 'b'.*RAG_UPSTREAM_ERROR.*store down/,
      ),
    );
    assert.deepEqual(executed, ['gather'], 'the dependent step must not run');
  });
});

describe('C2 stepper planner — a failing store fails the plan', () => {
  it('toolsRag.query throws → plan rejects, the planner LLM is not called', async () => {
    const l = llm('{"nodes":[{"id":"a","goal":"x"}]}');
    await assert.rejects(
      () =>
        new LlmStepperPlanner(l.obj as never).plan({
          prompt: 'task',
          knowledgeRag: knowledge() as never,
          toolsRag: failingTools as never,
          parentPath: ['root'],
          identity,
        }),
      isCoordinatorError(
        'COORDINATOR_PLAN_FAILED',
        /tools.*RAG_UPSTREAM_ERROR.*tools store down/,
      ),
    );
    assert.equal(l.calls, 0);
  });

  it('listArtifacts throws → plan rejects', async () => {
    const l = llm('{"nodes":[{"id":"a","goal":"x"}]}');
    await assert.rejects(
      () =>
        new LlmStepperPlanner(l.obj as never).plan({
          prompt: 'task',
          knowledgeRag: knowledge({
            async listArtifacts(): Promise<never> {
              throw new RagError('manifest down', 'RAG_UPSTREAM_ERROR');
            },
          }) as never,
          toolsRag: okTools as never,
          parentPath: ['root'],
          identity,
        }),
      isCoordinatorError(
        'COORDINATOR_PLAN_FAILED',
        /listArtifacts.*RAG_UPSTREAM_ERROR.*manifest down/,
      ),
    );
    assert.equal(l.calls, 0);
  });
});

describe('C3 evaluator — toolsRag.query throws', () => {
  it('the evaluator rejects', async () => {
    const l = llm('{"route":"executable","missing":[]}');
    await assert.rejects(
      () =>
        new LlmEvaluator(l.obj as never).evaluate({
          prompt: 'task',
          knowledgeRag: knowledge() as never,
          toolsRag: failingTools as never,
          identity,
        }),
      isCoordinatorError(
        'COORDINATOR_STEP_FAILED',
        /evaluator.*RAG_UPSTREAM_ERROR.*tools store down/,
      ),
    );
    assert.equal(l.calls, 0);
  });
});

function executorInput(knowledgeRag: unknown) {
  return {
    prompt: 'read program X',
    tools: [{ name: 'GetProgram', description: 'd', inputSchema: {} }],
    knowledgeRag: knowledgeRag as never,
    toolsRag: okTools as never,
    budget: { depthRemaining: 1, tokens: new TokenLedger(100000) },
    identity,
  } as never;
}

describe('C4 executor — knowledgeRag.query throws', () => {
  it('the step rejects, the LLM is not called', async () => {
    const l = llm('done');
    const exec = new CyclicReActExecutor({
      llm: l.obj as never,
      callMcp: async () => 'unused',
      component: 'tool-loop',
      maxIterations: 3,
    });
    await assert.rejects(
      () =>
        exec.execute(
          executorInput(
            knowledge({
              async query(): Promise<never> {
                throw new RagError('facts down', 'RAG_UPSTREAM_ERROR');
              },
            }),
          ),
        ),
      isCoordinatorError(
        'COORDINATOR_STEP_FAILED',
        /executor.*RAG_UPSTREAM_ERROR.*facts down/,
      ),
    );
    assert.equal(l.calls, 0);
  });
});

describe('C5 executor — the artifact store throws', () => {
  for (const which of ['hasArtifact', 'getArtifact'] as const) {
    it(`${which} throws → the step rejects, the live tool is not called`, async () => {
      let mcpCalls = 0;
      const toolCall = {
        name: 'stub',
        async chat() {
          return {
            ok: true as const,
            value: {
              content: '',
              toolCalls: [{ id: 'c1', name: 'GetProgram', arguments: {} }],
            },
          };
        },
      };
      const store = knowledge({
        async hasArtifact(): Promise<boolean> {
          if (which === 'hasArtifact')
            throw new RagError('index down', 'RAG_UPSTREAM_ERROR');
          return true;
        },
        async getArtifact(): Promise<string> {
          throw new RagError('index down', 'RAG_UPSTREAM_ERROR');
        },
      });
      const exec = new CyclicReActExecutor({
        llm: toolCall as never,
        callMcp: async () => {
          mcpCalls++;
          return 'live';
        },
        component: 'tool-loop',
        maxIterations: 3,
      });
      await assert.rejects(
        () => exec.execute(executorInput(store)),
        isCoordinatorError(
          'COORDINATOR_STEP_FAILED',
          /artifact store.*GetProgram.*RAG_UPSTREAM_ERROR.*index down/,
        ),
      );
      assert.equal(mcpCalls, 0, 'no live re-fetch in place of the store');
    });
  }
});

describe('C6 LLM need resolver', () => {
  it('the classifier LLM answers ok:false → rejects carrying the LlmError', async () => {
    await assert.rejects(
      () => new LlmNeedResolver(llmDown as never).resolve('I cannot read X'),
      isCoordinatorError(
        'COORDINATOR_STEP_FAILED',
        /need resolver.*LlmError.*LLM_ERROR.*quota/,
      ),
    );
  });

  it('the classifier LLM rejects → the same failure', async () => {
    await assert.rejects(
      () => new LlmNeedResolver(llmRejects as never).resolve('I cannot read X'),
      isCoordinatorError(
        'COORDINATOR_STEP_FAILED',
        /need resolver.*LlmError.*socket hang up/,
      ),
    );
  });

  it('malformed JSON → rejects carrying a ClassifierError', async () => {
    const l = llm('need: yes, maybe');
    await assert.rejects(
      () => new LlmNeedResolver(l.obj as never).resolve('I cannot read X'),
      isCoordinatorError(
        'COORDINATOR_STEP_FAILED',
        /need resolver.*ClassifierError.*CLASSIFIER_ERROR.*need: yes, maybe/,
      ),
    );
  });

  it('a well-formed "no need" answer stays "no need" (pinned)', async () => {
    const l = llm('{"need":false,"capability":""}');
    assert.equal(
      await new LlmNeedResolver(l.obj as never).resolve('the answer'),
      undefined,
    );
  });
});

describe('C7 LLM task formalizer', () => {
  it('an LLM error → rejects (no raw-prompt spec)', async () => {
    await assert.rejects(
      () => new LlmTaskFormalizer(llmDown as never).formalize({ prompt: 'p' }),
      isCoordinatorError(
        'COORDINATOR_PLAN_FAILED',
        /task formalizer.*LLM_ERROR.*quota/,
      ),
    );
  });

  it('a rejecting LLM → the same failure', async () => {
    await assert.rejects(
      () =>
        new LlmTaskFormalizer(llmRejects as never).formalize({ prompt: 'p' }),
      isCoordinatorError(
        'COORDINATOR_PLAN_FAILED',
        /task formalizer.*LLM_ERROR.*socket hang up/,
      ),
    );
  });

  it('unparseable output → rejects', async () => {
    const l = llm('I would rather not');
    await assert.rejects(
      () => new LlmTaskFormalizer(l.obj as never).formalize({ prompt: 'p' }),
      isCoordinatorError(
        'COORDINATOR_PLAN_FAILED',
        /task formalizer.*unparseable.*I would rather not/,
      ),
    );
  });
});

describe('fix round 1', () => {
  it('C7 a parsed reply with no objective → rejects (no raw-prompt objective)', async () => {
    const l = llm('{"constraints":["x"]}');
    await assert.rejects(
      () => new LlmTaskFormalizer(l.obj as never).formalize({ prompt: 'p' }),
      isCoordinatorError(
        'COORDINATOR_PLAN_FAILED',
        /task formalizer.*unparseable/,
      ),
    );
  });

  it('C6 a fenced verdict is parsed — "no need" stays "no need"', async () => {
    const l = llm('```json\n{"need":false,"capability":""}\n```');
    assert.equal(
      await new LlmNeedResolver(l.obj as never).resolve('the answer'),
      undefined,
    );
  });

  it('C6 a prose-wrapped need is parsed', async () => {
    const l = llm('Verdict: {"need":true,"capability":"read includes"} done');
    assert.deepEqual(
      await new LlmNeedResolver(l.obj as never).resolve('partial'),
      { queryToolsRag: 'read includes' },
    );
  });

  for (const content of ['{}', '{"need":"yes","capability":"x"}']) {
    it(`C6 ${content} (need not a boolean) → rejects carrying a ClassifierError`, async () => {
      const l = llm(content);
      await assert.rejects(
        () => new LlmNeedResolver(l.obj as never).resolve('x'),
        isCoordinatorError(
          'COORDINATOR_STEP_FAILED',
          /need resolver.*ClassifierError.*CLASSIFIER_ERROR/,
        ),
      );
    });
  }

  it('C1 two failing siblings → one COORDINATOR_STEP_FAILED naming both', async () => {
    const exec: IExecutor = {
      name: 'e',
      async execute() {
        return { status: 'ok', usage: ZERO };
      },
    };
    const plan: DagPlan = {
      nodes: [
        { id: 'a', goal: 'gather' },
        { id: 'b', goal: 'left', dependsOn: ['a'] },
        { id: 'c', goal: 'right', dependsOn: ['a'] },
      ],
      createdAt: 0,
    };
    let n = 0;
    await assert.rejects(
      () =>
        new StepperInterpreter().interpret(plan, {
          prompt: 'p',
          knowledgeRag: knowledge({
            async list(): Promise<never> {
              throw new RagError('store down', 'RAG_UPSTREAM_ERROR');
            },
          }) as never,
          toolsRag: okTools as never,
          childSteppers: new Map(),
          executor: exec,
          budget: { depthRemaining: 3, tokens: new TokenLedger(100000) },
          identity,
          maxParallelSteps: 4,
          mintStepperId: () => `s${n++}`,
        }),
      (e: unknown) =>
        e instanceof OrchestratorError &&
        e.code === 'COORDINATOR_STEP_FAILED' &&
        /node 'b'/.test(e.message) &&
        /node 'c'/.test(e.message) &&
        e.cause instanceof AggregateError &&
        e.cause.errors.length === 2,
    );
  });

  const failingKnowledge = knowledge({
    async query(): Promise<never> {
      throw new RagError('facts down', 'RAG_UPSTREAM_ERROR');
    },
  });

  it('C2 planner knowledgeRag.query throws → COORDINATOR_PLAN_FAILED', async () => {
    const l = llm('{"nodes":[{"id":"a","goal":"x"}]}');
    await assert.rejects(
      () =>
        new LlmStepperPlanner(l.obj as never).plan({
          prompt: 'task',
          knowledgeRag: failingKnowledge as never,
          toolsRag: okTools as never,
          parentPath: ['root'],
          identity,
        }),
      (e: unknown) =>
        isCoordinatorError(
          'COORDINATOR_PLAN_FAILED',
          /stepper planner: knowledge store query failed.*RAG_UPSTREAM_ERROR.*facts down/,
        )(e) && (e as Error).cause instanceof RagError,
    );
    assert.equal(l.calls, 0);
  });

  it('C3 evaluator knowledgeRag.query throws → COORDINATOR_STEP_FAILED', async () => {
    const l = llm('{"route":"executable","missing":[]}');
    await assert.rejects(
      () =>
        new LlmEvaluator(l.obj as never).evaluate({
          prompt: 'task',
          knowledgeRag: failingKnowledge as never,
          toolsRag: okTools as never,
          identity,
        }),
      (e: unknown) =>
        isCoordinatorError(
          'COORDINATOR_STEP_FAILED',
          /evaluator: knowledge store query failed.*RAG_UPSTREAM_ERROR.*facts down/,
        )(e) && (e as Error).cause instanceof RagError,
    );
    assert.equal(l.calls, 0);
  });
});
