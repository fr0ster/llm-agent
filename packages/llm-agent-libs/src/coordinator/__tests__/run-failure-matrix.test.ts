import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  httpStatusOf,
  type ILlm,
  LlmError,
  type LlmResponse,
  McpError,
  type Result,
  SmartAgentError,
  TokenLedger,
} from '@mcp-abap-adt/llm-agent';
import { SmartAgent } from '../../agent.js';
import { SmartAgentBuilder } from '../../builder.js';
import { unwrapBuilderResult } from '../../builder-types.js';
import { DirectLlmSubAgent } from '../../subagent/direct-llm-subagent.js';
import {
  makeDefaultDeps,
  testCallOptions,
  testRequestAccess,
} from '../../testing/index.js';
import {
  DEFAULT_BUDGET,
  runAdaptivePlan,
} from '../adaptive/adaptive-interpreter.js';
import { LlmAdaptiveController } from '../adaptive/llm-adaptive-controller.js';
import { DagPlanInterpreter } from '../dag/dag-plan-interpreter.js';
import { DialogueSession } from '../dialogue/dialogue-session.js';
import { SelfDispatch } from '../dispatch/self.js';
import { CyclicReActExecutor } from '../stepper/cyclic-react-executor.js';
import { StepperInterpreter } from '../stepper/stepper-interpreter.js';

const { caller } = testCallOptions();
const workerName = 'executor';
const node = { id: 'work', agent: workerName, goal: 'Write' };
const done = { content: 'Recovered', finishReason: 'stop' } as const;

function workers(llm: ILlm) {
  return new Map([
    [
      workerName,
      new DirectLlmSubAgent(workerName, llm, {
        systemPrompt: '',
        contextPolicy: 'optional',
      }),
    ],
  ]);
}

async function dag(llm: ILlm) {
  let recoveries = 0;
  const result = await new DagPlanInterpreter().interpret(
    { nodes: [node], createdAt: 0 },
    {
      caller,
      sessionId: caller.sessionId,
      inputText: 'Write',
      workers: workers(llm),
      errorStrategy: {
        name: 'retry as a subplan',
        async onNodeFailure() {
          assert.equal(++recoveries, 1);
          return {
            action: 'replan',
            subPlan: { nodes: [{ ...node, id: 'retry' }], createdAt: 0 },
          };
        },
      },
    },
  );
  assert.ok(result.ok);
  assert.equal(recoveries, 1);
  assert.deepEqual(
    Object.values(result.nodeResults).map(({ output }) => output),
    [done.content],
  );
}

async function adaptive(llm: ILlm) {
  const result = await runAdaptivePlan({
    caller,
    request: 'Write',
    history: [],
    plan: {
      createdAt: 0,
      steps: [
        { id: node.id, kind: 'work', worker: workerName, goal: node.goal },
      ],
    },
    workers: workers(llm),
    controller: new LlmAdaptiveController(llm),
    budget: DEFAULT_BUDGET,
  });
  assert.equal(result.outcome, 'stopped');
  assert.deepEqual(
    result.records.map(({ stepId, status }) => [stepId, status]),
    [[node.id, 'failed']],
  );
  assert.ok(result.error);
  throw result.error;
}

async function stepper(llm: ILlm) {
  const result = await new StepperInterpreter().interpret(
    { nodes: [{ id: node.id, goal: node.goal }], createdAt: 0 },
    {
      prompt: 'Write',
      identity: {
        traceId: 't',
        turnId: 'u',
        sessionId: 's',
        stepperId: 'root',
      },
      knowledgeRag: {
        query: async () => [],
        list: async () => [],
        write: async () => {},
        fingerprint: () => 'empty',
      },
      toolsRag: { query: async () => [], lookup: () => undefined },
      executor: new CyclicReActExecutor({
        llm,
        component: 'tool-loop',
        callMcp: () => assert.fail('no tools were offered'),
      }),
      childSteppers: new Map(),
      budget: { depthRemaining: 0, tokens: new TokenLedger(100_000) },
      maxParallelSteps: 1,
      mintStepperId: () => node.id,
    },
  );
  assert.equal(result.status, 'incomplete');
  assert.deepEqual(result.missing, ['Request failed']);
}

async function dispatch(llm: ILlm) {
  const handle = await new SmartAgentBuilder({ skipModelValidation: true })
    .withRagAccess(testRequestAccess)
    .withMainLlm(llm)
    .withClassification(false)
    .withCoordinator({
      dispatch: new SelfDispatch(llm),
      maxRetriesPerStep: 1,
      failPolicy: 'continue',
      planning: {
        name: 'scripted plan',
        async buildInitialPlan() {
          return {
            source: 'planner-llm',
            createdAt: 0,
            steps: [{ id: node.id, goal: node.goal, status: 'pending' }],
          };
        },
        shouldReplan: () => false,
        rebuildPlan: () => assert.fail('unexpected replan'),
      },
    })
    .build()
    .then(unwrapBuilderResult);
  try {
    const result = await handle.agent.process('Write', testCallOptions());
    if (!result.ok) throw result.error;
    assert.match(result.value.content, /Recovered/);
  } finally {
    await handle.close();
  }
}

async function dialogue(llm: ILlm, failure: FailureCase) {
  const session = await DialogueSession.open({
    id: caller.sessionId,
    caller,
    board: { workers: new Map() },
    planner: new SmartAgent({ ...makeDefaultDeps().deps, mainLlm: llm }, {}),
  });
  try {
    if (failure.terminalCode) {
      await session.send('Write');
      assert.fail('the first dialogue turn must surface the provider failure');
    }
    await assert.rejects(session.send('Write'), {
      message: 'Request failed',
    });
    assert.equal((await session.send('Continue')).text, done.content);
    assert.deepEqual(
      session.snapshot().requests?.map(({ id }) => id),
      ['r1'],
    );
  } finally {
    await session.close();
  }
}

interface FailureCase {
  name: string;
  response: Result<LlmResponse, LlmError>;
  terminalCode?: string;
  status?: number;
}

const httpFailure = (status: number, terminal: boolean): FailureCase => ({
  name: `HTTP ${status}`,
  response: {
    ok: false,
    error: Object.assign(new LlmError('Request failed'), {
      response: { status },
    }),
  },
  terminalCode: terminal ? 'LLM_ERROR' : undefined,
  status,
});

const failures: FailureCase[] = [
  {
    name: 'truncation',
    response: {
      ok: true,
      value: { content: 'Partial', finishReason: 'length' },
    },
    terminalCode: 'LLM_OUTPUT_TRUNCATED',
  },
  httpFailure(401, true),
  httpFailure(400, true),
  {
    name: 'abort',
    response: { ok: false, error: new LlmError('Aborted', 'ABORTED') },
    terminalCode: 'ABORTED',
  },
  {
    name: 'MCP_ERROR',
    response: { ok: false, error: new McpError('Request failed') },
  },
  httpFailure(503, false),
];

for (const [kind, run] of Object.entries({
  dag,
  adaptive,
  stepper,
  dispatch,
  dialogue,
})) {
  for (const failure of kind === 'dispatch'
    ? [...failures, httpFailure(404, true), httpFailure(422, true)]
    : failures) {
    const stopCode =
      failure.terminalCode ??
      (kind === 'adaptive' && !failure.response.ok
        ? failure.response.error.code
        : undefined);
    test(`${kind} ${stopCode ? 'stops on' : 'recovers from'} ${failure.name}`, async () => {
      let calls = 0;
      const respond: ILlm['chat'] = async () =>
        ++calls === 1 ? failure.response : { ok: true, value: done };
      const llm: ILlm = {
        chat: respond,
        async *streamChat(...args) {
          yield await respond(...args);
        },
      };
      if (stopCode) {
        await assert.rejects(run(llm, failure), (error) => {
          assert.ok(error instanceof SmartAgentError);
          assert.equal(error.code, stopCode);
          assert.equal(httpStatusOf(error), failure.status);
          return true;
        });
        assert.equal(calls, 1);
      } else {
        await run(llm, failure);
        assert.equal(calls, kind === 'stepper' ? 1 : 2);
      }
    });
  }
}
