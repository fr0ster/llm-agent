import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  IAdaptiveController,
  IFinalizer,
  ILlm,
  IMcpClient,
  ISubAgent,
} from '@mcp-abap-adt/llm-agent';
import { SmartAgentBuilder } from '../builder.js';
import { unwrapBuilderResult } from '../builder-types.js';
import { LlmAdaptiveController } from '../coordinator/adaptive/llm-adaptive-controller.js';
import { DagPlanInterpreter } from '../coordinator/dag/dag-plan-interpreter.js';
import { DefaultRequestLogger } from '../logger/default-request-logger.js';
import { SessionRequestLogger } from '../logger/session-request-logger.js';
import { WorkerRequestLogger } from '../logger/worker-request-logger.js';
import { AdaptiveCoordinatorHandler } from '../pipeline/handlers/adaptive-coordinator.js';
import { SmartAgentSubAgent } from '../subagent/smart-agent-subagent.js';
import { testCallOptions, testRequestAccess } from '../testing/index.js';

const firstUsage = { promptTokens: 17, completionTokens: 3, totalTokens: 20 };
const secondUsage = { promptTokens: 23, completionTokens: 7, totalTokens: 30 };
const plannerUsage = { promptTokens: 8, completionTokens: 1, totalTokens: 9 };
const finalizerUsage = {
  promptTokens: 31,
  completionTokens: 11,
  totalTokens: 42,
};
const traceId = 'usage-test';

function builder() {
  return new SmartAgentBuilder({ skipModelValidation: true })
    .withRagAccess(testRequestAccess)
    .withClassification(false);
}

const unusedLlm: ILlm = {
  chat: async () => assert.fail('Unexpected chat'),
  streamChat: () => assert.fail('Unexpected stream'),
};
const finalizer: IFinalizer = {
  name: 'finalizer',
  async finalize(input) {
    input.onPartial?.({ kind: 'content', delta: 'final answer' });
    return { output: 'final answer', model: 'checker', usage: finalizerUsage };
  },
};

test('adaptive controller reads the LLM model for each request', async () => {
  let model = 'initial';
  const controller = new LlmAdaptiveController({
    ...unusedLlm,
    get model() {
      return model;
    },
    async chat() {
      return {
        ok: true,
        value: {
          content: '{"steps":[{"id":"a","kind":"answer","text":"answer"}]}',
          finishReason: 'stop',
          usage: plannerUsage,
        },
      };
    },
  });
  const parent = await builder()
    .withMainLlm(unusedLlm)
    .withStepperCoordinator(
      new AdaptiveCoordinatorHandler({
        controller,
        workers: new Map(),
      }),
    )
    .build()
    .then(unwrapBuilderResult);
  try {
    for (const selected of ['first-request', 'second-request']) {
      model = selected;
      assert.equal(controller.model, selected);
      const result = await parent.agent.process('request', testCallOptions());
      assert.ok(result.ok);
      assert.deepEqual(result.value.usage?.models, {
        [selected]: { ...plannerUsage, requests: 1 },
      });
    }
  } finally {
    await parent.close();
  }
});

for (const mode of ['adaptive', 'dag'] as const) {
  for (const loggerMode of [
    'separate',
    'shared session',
    'shared default',
  ] as const) {
    test(`${mode} reports every worker round with ${loggerMode} loggers`, async () => {
      const parentLogger =
        loggerMode === 'shared default'
          ? new DefaultRequestLogger()
          : new SessionRequestLogger();
      const workerLogger =
        loggerMode === 'separate' ? new DefaultRequestLogger() : parentLogger;
      let round = 0;
      const workerLlm: ILlm = {
        ...unusedLlm,
        get model() {
          return round === 1 ? 'worker-first' : 'worker-second';
        },
        async *streamChat() {
          round++;
          if (round === 1) {
            yield {
              ok: true,
              value: {
                content: '',
                toolCalls: [{ id: 'call', name: 'lookup', arguments: {} }],
                finishReason: 'tool_calls',
                usage: firstUsage,
              },
            };
          } else {
            assert.equal(round, 2);
            yield {
              ok: true,
              value: {
                content: 'worker answer',
                finishReason: 'stop',
                usage: secondUsage,
              },
            };
          }
        },
      };
      const client: IMcpClient = {
        async listTools() {
          return {
            ok: true,
            value: [
              { name: 'lookup', description: 'Look up', inputSchema: {} },
            ],
          };
        },
        async callTool() {
          return { ok: true, value: { content: 'found' } };
        },
      };
      const worker = await builder()
        .withMainLlm(workerLlm)
        .withMcpClients([client])
        .withRequestLogger(workerLogger)
        .build()
        .then(unwrapBuilderResult);
      const workers = new Map([
        ['worker', new SmartAgentSubAgent('worker', worker.agent)],
      ]);
      const controller: IAdaptiveController = {
        name: 'controller',
        model: 'default-planner',
        async plan() {
          return {
            plan: {
              createdAt: 0,
              steps: [
                { kind: 'work', id: 'work', goal: 'lookup', worker: 'worker' },
                { kind: 'answer', id: 'answer', from: 'work' },
              ],
            },
            model: 'planner',
            usage: plannerUsage,
          };
        },
        check: async () => assert.fail('Unexpected check'),
        revise: async () => assert.fail('Unexpected revision'),
        report: async () => assert.fail('Unexpected report'),
      };
      const parentBuilder = builder()
        .withMainLlm(unusedLlm)
        .withRequestLogger(parentLogger);
      if (mode === 'adaptive') {
        parentBuilder.withStepperCoordinator(
          new AdaptiveCoordinatorHandler({ controller, workers, finalizer }),
        );
      } else {
        parentBuilder.withDagCoordinator({
          planner: {
            name: 'planner',
            model: 'default-planner',
            async plan() {
              return {
                plan: {
                  createdAt: 0,
                  nodes: [{ id: 'work', goal: 'lookup', worker: 'worker' }],
                },
                model: 'planner',
                usage: plannerUsage,
              };
            },
          },
          interpreter: new DagPlanInterpreter(),
          workers,
          finalizer: { ...finalizer, model: 'default-finalizer' },
        });
      }
      const parent = await parentBuilder.build().then(unwrapBuilderResult);
      try {
        const result = await parent.agent.process(
          'request',
          testCallOptions({ trace: { traceId } }),
        );
        assert.ok(result.ok, result.ok ? undefined : result.error.message);
        assert.equal(result.value.content, 'final answer');
        assert.equal(round, 2);
        const expected = {
          planner: { ...plannerUsage, requests: 1 },
          'worker-first': { ...firstUsage, requests: 1 },
          'worker-second': { ...secondUsage, requests: 1 },
          checker: { ...finalizerUsage, requests: 1 },
        };
        assert.deepEqual(parentLogger.getSummary(traceId).byModel, expected);
        assert.deepEqual(result.value.usage?.models, expected);
      } finally {
        await parent.close();
        await worker.close();
      }
    });
  }
}

for (const mode of ['adaptive', 'dag'] as const) {
  test(`${mode} imports a custom worker's per-model counts once`, async () => {
    const models = {
      'first-model': { ...firstUsage, cachedInputTokens: 5, requests: 2 },
      'second-model': { ...secondUsage, requests: 1 },
    };
    const worker: ISubAgent = {
      name: 'worker',
      model: 'default-worker',
      capabilities: { contextPolicy: 'optional' },
      async run() {
        return {
          output: 'result',
          usage: {
            promptTokens: 40,
            completionTokens: 10,
            totalTokens: 50,
            models,
          },
        };
      },
    };
    const workers = new Map([['worker', worker]]);
    const parentBuilder = builder().withMainLlm(unusedLlm);
    if (mode === 'adaptive') {
      parentBuilder.withStepperCoordinator(
        new AdaptiveCoordinatorHandler({
          workers,
          controller: {
            name: 'controller',
            async plan() {
              return {
                plan: {
                  createdAt: 0,
                  steps: [
                    {
                      kind: 'work',
                      id: 'work',
                      goal: 'work',
                      worker: 'worker',
                    },
                    { kind: 'answer', id: 'a', from: 'work' },
                  ],
                },
              };
            },
            check: async () => assert.fail('Unexpected check'),
            revise: async () => assert.fail('Unexpected revision'),
            report: async () => assert.fail('Unexpected report'),
          },
        }),
      );
    } else {
      parentBuilder.withDagCoordinator({
        workers,
        interpreter: new DagPlanInterpreter(),
        planner: {
          name: 'planner',
          async plan() {
            return {
              plan: {
                createdAt: 0,
                nodes: [{ id: 'work', goal: 'work', worker: 'worker' }],
              },
            };
          },
        },
      });
    }
    const parent = await parentBuilder.build().then(unwrapBuilderResult);
    try {
      const result = await parent.agent.process('request', testCallOptions());
      assert.ok(result.ok);
      assert.deepEqual(result.value.usage?.models, models);
    } finally {
      await parent.close();
    }
  });
}

test('adaptive check, revision and stop report each use their call model', async () => {
  const controller: IAdaptiveController = {
    name: 'controller',
    model: 'default-controller',
    async plan() {
      return {
        plan: {
          createdAt: 0,
          steps: [
            {
              id: 'check',
              kind: 'check',
              worker: 'self',
              goal: 'Check',
              targets: [],
              onPass: 'next',
              onFail: 'end',
            },
            { id: 'revise', kind: 'revise', reason: 'Revise' },
          ],
        },
      };
    },
    async check() {
      return {
        verdict: { verdict: 'pass', reason: 'ok' },
        model: 'reviewer',
        usage: firstUsage,
      };
    },
    async revise() {
      return { steps: [], model: 'revision', usage: secondUsage };
    },
    async report() {
      return { text: 'report', model: 'reporter', usage: finalizerUsage };
    },
  };
  const parent = await builder()
    .withMainLlm(unusedLlm)
    .withStepperCoordinator(
      new AdaptiveCoordinatorHandler({ controller, workers: new Map() }),
    )
    .build()
    .then(unwrapBuilderResult);
  try {
    const result = await parent.agent.process('request', testCallOptions());
    assert.ok(result.ok);
    assert.equal(result.value.content, 'report');
    assert.deepEqual(result.value.usage?.models, {
      reviewer: { ...firstUsage, requests: 1 },
      revision: { ...secondUsage, requests: 1 },
      reporter: { ...finalizerUsage, requests: 1 },
    });
  } finally {
    await parent.close();
  }
});

test('nested workers sharing a scoped logger contribute each call once', () => {
  const root = new DefaultRequestLogger();
  const parent = new WorkerRequestLogger(new DefaultRequestLogger(), root);
  const child = new WorkerRequestLogger(parent, parent);
  root.startRequest(traceId);
  parent.startRequest(traceId);
  parent.logLlmCall({
    component: 'planner',
    model: 'planner',
    ...plannerUsage,
    durationMs: 0,
    requestId: traceId,
  });
  child.startRequest(traceId);
  child.logLlmCall({
    component: 'tool-loop',
    model: 'worker',
    ...firstUsage,
    durationMs: 0,
    requestId: traceId,
  });
  child.endRequest(traceId);
  parent.endRequest(traceId);
  root.endRequest(traceId);
  const expected = {
    planner: { ...plannerUsage, requests: 1 },
    worker: { ...firstUsage, requests: 1 },
  };
  assert.deepEqual(root.getSummary(traceId).byModel, expected);
  assert.deepEqual(parent.getSummary(traceId).byModel, expected);
  assert.deepEqual(child.getSummary(traceId).byModel, {
    worker: expected.worker,
  });
});
