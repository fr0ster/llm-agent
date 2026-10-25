import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type CallOptions,
  type ICoordinatorContext,
  type IKnowledgeRagHandle,
  type ILlm,
  type IToolsRagHandle,
  type IUsageRecorder,
  startOperation,
  TokenLedger,
  type UsageContext,
  type UsageInput,
} from '@mcp-abap-adt/llm-agent';
import type { SmartAgent } from '../../agent.js';
import { DirectLlmSubAgent } from '../../subagent/direct-llm-subagent.js';
import { SmartAgentSubAgent } from '../../subagent/smart-agent-subagent.js';
import { LlmAdaptiveController } from '../adaptive/llm-adaptive-controller.js';
import { LlmDagPlanner } from '../dag/llm-dag-planner.js';
import { LlmFinalizer } from '../dag/llm-finalizer.js';
import { LlmReviewStrategy } from '../dag/llm-review-strategy.js';
import { SubAgentStateOracle } from '../dag/subagent-state-oracle.js';
import { SelfDispatch } from '../dispatch/self.js';
import { OneShotPlanning } from '../planning/one-shot.js';
import { ReplanOnErrorPlanning } from '../planning/replan-on-error.js';
import { CyclicReActExecutor } from '../stepper/cyclic-react-executor.js';
import { LlmEvaluator } from '../stepper/llm-evaluator.js';
import { LlmStepperPlanner } from '../stepper/llm-stepper-planner.js';
import { LlmTaskFormalizer } from '../stepper/llm-task-formalizer.js';
import { LoggingLlm } from '../stepper/logging-llm.js';
import { LlmNeedResolver } from '../stepper/need-resolver.js';
import { RootFinalizer } from '../stepper/root-finalizer.js';

function recorder(
  context: UsageContext = {},
  seen: UsageInput[] = [],
): IUsageRecorder {
  return {
    with(next) {
      return recorder({ ...context, ...next }, seen);
    },
    record(input) {
      seen.push({ ...input, context: { ...context, ...input.context } });
    },
  };
}
function fake(content: string, seen: CallOptions[]): ILlm {
  return {
    async chat(_messages, _tools, options) {
      assert.ok(options?.usage);
      seen.push(options);
      options.usage.record({
        kind: 'x.test',
        context: {},
        outcome: 'ok',
        values: {},
      });
      return { ok: true, value: { content, finishReason: 'stop' } };
    },
    async *streamChat(_messages, _tools, options) {
      assert.ok(options?.usage);
      seen.push(options);
      options.usage.record({
        kind: 'x.test',
        context: {},
        outcome: 'ok',
        values: {},
      });
      yield { ok: true, value: { content, finishReason: 'stop' } };
    },
  };
}
function context(usage: IUsageRecorder): ICoordinatorContext {
  return {
    inputText: 'task',
    registry: new Map(),
    stepResults: {},
    sessionId: 'session',
    usage,
  };
}

test('coordinator LLM boundaries forward recorders with their component roles', async () => {
  const inputs: UsageInput[] = [];
  const usage = recorder({ sessionId: 'session', taskId: 'task' }, inputs);
  const seen: CallOptions[] = [];
  await new OneShotPlanning(fake('{"steps":[]}', seen)).buildInitialPlan(
    context(usage),
  );
  await new SelfDispatch(fake('answer', seen)).dispatch(
    { id: 's', goal: 'task', status: 'pending' },
    context(usage),
  );
  await new LlmFinalizer(fake('answer', seen)).finalize({
    prompt: 'task',
    objective: 'task',
    interpreterOutput: 'answer',
    executionTrace: [],
    usage,
  });
  await new LlmNeedResolver(fake('{"need":false}', seen)).resolve('answer', {
    usage,
  });
  const controller = new LlmAdaptiveController(
    fake('{"steps":[{"id":"answer","kind":"answer","text":"done"}]}', seen),
  );
  await controller.plan({ request: 'task', history: [], workers: [], usage });
  assert.deepEqual(
    inputs.map((input) => input.context.role),
    ['planner', 'executor', 'finalizer', 'classifier', 'planner'],
  );
  assert.ok(inputs.every((input) => input.context.taskId === 'task'));
});

test('both worker adapters forward input.usage without losing caller context', async () => {
  const usage = recorder({ taskId: 'one' });
  const seen: CallOptions[] = [];
  await new DirectLlmSubAgent('worker', fake('answer', seen), {
    systemPrompt: 'system',
    contextPolicy: 'optional',
  }).run({ task: 'task', usage });
  let processOptions: CallOptions | undefined;
  const agent = {
    async process(_input: unknown, options: CallOptions) {
      processOptions = options;
      return { ok: true, value: { content: 'answer' } };
    },
  } as unknown as SmartAgent;
  await new SmartAgentSubAgent('worker', agent).run({ task: 'task', usage });
  assert.equal(seen[0].usage, usage);
  assert.equal(processOptions?.usage, usage);
});

test('LoggingLlm preserves operation and recorder across chat and stream', async () => {
  const usage = recorder();
  const usageOp = startOperation();
  const seen: CallOptions[] = [];
  const llm = new LoggingLlm(fake('answer', seen), () => {});
  const options = { usage, usageOp };
  await llm.chat([], [], options);
  for await (const _chunk of llm.streamChat([], [], options)) {
    /* consume */
  }
  assert.equal(seen.length, 2);
  assert.ok(
    seen.every(
      (opt) =>
        opt.usage === usage &&
        opt.usageOp?.operationId === usageOp.operationId &&
        opt.usageOp.seq === usageOp.seq &&
        opt.usageOp !== usageOp &&
        opt !== options,
    ),
  );
});

test('self dispatch passes the recorder to its MCP callback', async () => {
  const usage = recorder();
  let count = 0;
  let mcpOptions: CallOptions | undefined;
  const llm: ILlm = {
    async chat() {
      return {
        ok: true,
        value:
          count++ === 0
            ? {
                content: '',
                finishReason: 'tool_calls',
                toolCalls: [{ id: 'tc', name: 'read', arguments: {} }],
              }
            : { content: 'answer', finishReason: 'stop' },
      };
    },
    async *streamChat() {},
  };
  const ctx = context(usage);
  ctx.selectedTools = [
    {
      name: 'read',
      description: 'read',
      inputSchema: { type: 'object', properties: {} },
    },
  ];
  ctx.callTool = async (_name, _args, _signal, options) => {
    mcpOptions = options;
    return 'result';
  };
  const result = await new SelfDispatch(llm).dispatch(
    { id: 's', goal: 'read', status: 'pending' },
    ctx,
  );
  assert.equal(result.ok, true);
  assert.ok(mcpOptions?.usage);
});

test('DAG roles and legacy replanning keep recorder context', async () => {
  const records: UsageInput[] = [];
  const usage = recorder({ taskId: 'dag' }, records);
  const seen: CallOptions[] = [];
  const plan = { nodes: [{ id: 'one', goal: 'work' }], createdAt: 0 };
  await new LlmDagPlanner(fake(JSON.stringify(plan), seen)).plan({
    prompt: 'task',
    agents: [],
    sessionId: 's',
    usage,
  });
  const reviewer = new LlmReviewStrategy(
    fake('{"pass":true,"action":"abort"}', seen),
  );
  await reviewer.review({
    prompt: 'task',
    plan,
    agents: [],
    sessionId: 's',
    usage,
  });
  await reviewer.reviewExecutionFailure({
    plan,
    trace: [],
    failedNodeId: 'one',
    error: 'failed',
    agents: [],
    sessionId: 's',
    usage,
  });
  await new ReplanOnErrorPlanning(
    fake('{"steps":[{"id":"new","goal":"work"}]}', seen),
  ).rebuildPlan(context(usage), []);
  await new SubAgentStateOracle(
    new DirectLlmSubAgent('oracle', fake('fact', seen), {
      systemPrompt: 'system',
      contextPolicy: 'optional',
    }),
  ).query({ query: 'fact', usage });
  assert.deepEqual(
    records.map((record) => record.context.role),
    ['planner', 'reviewer', 'reviewer', 'planner', 'oracle'],
  );
  assert.ok(records.every((record) => record.context.taskId === 'dag'));
});

test('stepper LLM roles and RAG reads and writes retain the recorder', async () => {
  const records: UsageInput[] = [];
  const usage = recorder({ taskId: 'stepper' }, records);
  const seen: CallOptions[] = [];
  const ragOptions: Array<CallOptions | undefined> = [];
  const knowledgeRag: IKnowledgeRagHandle = {
    async query(_text, opts) {
      ragOptions.push(opts?.options);
      return [];
    },
    async list() {
      return [];
    },
    async write(_entry, options) {
      ragOptions.push(options);
    },
    fingerprint() {
      return 'test';
    },
  };
  const toolsRag: IToolsRagHandle = {
    async query(_text, _k, options) {
      ragOptions.push(options);
      return [];
    },
    lookup() {
      return undefined;
    },
  };
  const identity = {
    traceId: 'trace',
    turnId: 'turn',
    sessionId: 'session',
    stepperId: 'stepper',
  };
  const input = { prompt: 'task', knowledgeRag, toolsRag, identity, usage };
  await new LlmEvaluator(
    fake('{"route":"executable","missing":[]}', seen),
  ).evaluate(input);
  await new LlmStepperPlanner(
    fake('{"nodes":[{"id":"one","goal":"work"}]}', seen),
  ).plan({ ...input, parentPath: [] });
  await new LlmTaskFormalizer(fake('{"objective":"task"}', seen)).formalize(
    input,
  );
  await new RootFinalizer(fake('answer', seen)).finalize({
    ...input,
    turnId: 'turn',
  });
  await new CyclicReActExecutor({
    llm: fake('answer', seen),
    callMcp: async () => 'result',
    component: 'executor',
    maxIterations: 1,
    allowToolless: true,
  }).execute({
    ...input,
    tools: [],
    budget: { depthRemaining: 1, tokens: new TokenLedger(100) },
    evaluatorNeeds: ['read'],
  });
  assert.deepEqual(
    records.map((record) => record.context.role),
    ['evaluator', 'planner', 'planner', 'finalizer', 'executor'],
  );
  assert.ok(ragOptions.length > 5);
  assert.ok(ragOptions.every((options) => options?.usage === usage));
});
