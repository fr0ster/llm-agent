import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  IAdaptiveController,
  IFinalizer,
  ILlm,
  IMcpClient,
  IRequestLogger,
  ISubAgent,
  LlmCallRecord,
} from '@mcp-abap-adt/llm-agent';
import { LlmError } from '@mcp-abap-adt/llm-agent';
import { SmartAgent } from '../agent.js';
import { SmartAgentBuilder } from '../builder.js';
import { unwrapBuilderResult } from '../builder-types.js';
import { LlmAdaptiveController } from '../coordinator/adaptive/llm-adaptive-controller.js';
import { DagPlanInterpreter } from '../coordinator/dag/dag-plan-interpreter.js';
import { LlmFinalizer } from '../coordinator/dag/llm-finalizer.js';
import type { IPipeline } from '../interfaces/pipeline.js';
import { DefaultRequestLogger } from '../logger/default-request-logger.js';
import { SessionRequestLogger } from '../logger/session-request-logger.js';
import { WorkerRequestLogger } from '../logger/worker-request-logger.js';
import { AdaptiveCoordinatorHandler } from '../pipeline/handlers/adaptive-coordinator.js';
import { RetryLlm } from '../resilience/retry-llm.js';
import { SmartAgentSubAgent } from '../subagent/smart-agent-subagent.js';
import {
  makeDefaultDeps,
  testCallOptions,
  testRequestAccess,
} from '../testing/index.js';

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

function dagWorker(
  worker: ISubAgent,
  logger: IRequestLogger,
  synthesize = finalizer,
) {
  return builder()
    .withMainLlm(unusedLlm)
    .withRequestLogger(logger)
    .withDagCoordinator({
      planner: {
        name: 'planner',
        async plan() {
          return {
            plan: {
              createdAt: 0,
              nodes: [{ id: 'work', goal: 'lookup', worker: worker.name }],
            },
          };
        },
      },
      interpreter: new DagPlanInterpreter(),
      workers: new Map([[worker.name, worker]]),
      finalizer: synthesize,
    })
    .build()
    .then(unwrapBuilderResult);
}

test('a planner error forwarded by an adaptive DAG worker is imported by call id', async () => {
  let calls = 0;
  const logger = new SessionRequestLogger();
  const controller = new LlmAdaptiveController({
    ...unusedLlm,
    model: 'nested-planner',
    async chat() {
      calls++;
      return {
        ok: false,
        error: Object.assign(
          new LlmError('nested planner failed', 'LLM_HTTP_ERROR'),
          {
            usage: firstUsage,
          },
        ),
      };
    },
  });
  const worker = await builder()
    .withMainLlm(unusedLlm)
    .withRequestLogger(logger)
    .withStepperCoordinator(
      new AdaptiveCoordinatorHandler({ controller, workers: new Map() }),
    )
    .build()
    .then(unwrapBuilderResult);
  const parent = await dagWorker(
    new SmartAgentSubAgent('worker', worker.agent),
    logger,
  );
  try {
    const result = await parent.agent.process(
      'request',
      testCallOptions({ trace: { traceId } }),
    );
    assert.equal(result.ok, false);
    assert.equal(calls, 1);
    const expected = { 'nested-planner': { ...firstUsage, requests: 1 } };
    for (const id of [traceId, undefined]) {
      const summary = logger.getSummary(id);
      assert.deepEqual(summary.byModel, expected);
      assert.deepEqual(summary.byComponent, {
        planner: expected['nested-planner'],
      });
    }
  } finally {
    await parent.close();
    await worker.close();
  }
});

for (const loggerMode of [
  'shared',
  'separate',
  'returned usage only',
] as const) {
  test(`a custom setPipeline worker contributes once with ${loggerMode}`, async () => {
    const logger = new SessionRequestLogger();
    const workerLogger =
      loggerMode === 'shared' ? logger : new SessionRequestLogger();
    const models = { 'custom-model': { ...firstUsage, requests: 1 } };
    let calls = 0;
    let configuredLogger: IRequestLogger | undefined;
    const pipeline: IPipeline = {
      initialize(deps) {
        configuredLogger = deps.requestLogger;
      },
      async execute(_input, _history, options, yieldChunk) {
        assert.ok(configuredLogger);
        calls++;
        if (loggerMode !== 'returned usage only') {
          configuredLogger.logLlmCall({
            ...firstUsage,
            model: 'custom-model',
            component: 'tool-loop',
            durationMs: 0,
            requestId: options?.trace?.traceId,
          });
        }
        yieldChunk({
          ok: true,
          value: {
            content: 'worker answer',
            finishReason: 'stop',
            usage: { ...firstUsage, models },
          },
        });
        return { timing: [] };
      },
    };
    const worker = await builder()
      .withMainLlm(unusedLlm)
      .withRequestLogger(workerLogger)
      .setPipeline(pipeline)
      .build()
      .then(unwrapBuilderResult);
    const parent = await dagWorker(
      new SmartAgentSubAgent('worker', worker.agent),
      logger,
    );
    try {
      const result = await parent.agent.process(
        'request',
        testCallOptions({ trace: { traceId } }),
      );
      assert.ok(result.ok);
      assert.equal(calls, 1);
      const expected = {
        ...models,
        checker: { ...finalizerUsage, requests: 1 },
      };
      assert.deepEqual(result.value.usage?.models, expected);
      assert.deepEqual(logger.getSummary(traceId).byModel, expected);
      assert.deepEqual(logger.getSummary().byModel, expected);
      if (loggerMode === 'separate') {
        assert.deepEqual(workerLogger.getSummary(traceId).byModel, models);
        assert.deepEqual(workerLogger.getSummary().byModel, models);
      }
    } finally {
      await parent.close();
      await worker.close();
    }
  });
}

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

for (const mode of ['pipeline', 'smart', 'pass'] as const) {
  test(`a failed SmartAgent worker call is counted once in ${mode} mode`, async () => {
    for (const streamedUsage of [firstUsage, undefined]) {
      const logger = new SessionRequestLogger();
      const failure = Object.assign(new LlmError('worker failed'), {
        model: 'worker-model',
        usage: firstUsage,
      });
      const mainLlm: ILlm = {
        ...unusedLlm,
        model: 'worker-model',
        async *streamChat() {
          if (streamedUsage) {
            yield { ok: true, value: { content: '', usage: streamedUsage } };
          }
          yield {
            ok: false,
            error: failure,
          };
        },
      };
      const worker =
        mode === 'pipeline'
          ? await builder()
              .withMainLlm(mainLlm)
              .build()
              .then(unwrapBuilderResult)
          : {
              agent: new SmartAgent(
                { ...makeDefaultDeps().deps, mainLlm },
                { mode },
              ),
            };
      const parent = await builder()
        .withMainLlm(unusedLlm)
        .withRequestLogger(logger)
        .withDagCoordinator({
          planner: {
            name: 'planner',
            async plan() {
              return {
                plan: {
                  createdAt: 0,
                  nodes: [{ id: 'work', goal: 'lookup', worker: 'worker' }],
                },
              };
            },
          },
          interpreter: new DagPlanInterpreter(),
          workers: new Map([
            ['worker', new SmartAgentSubAgent('worker', worker.agent)],
          ]),
          finalizer,
        })
        .build()
        .then(unwrapBuilderResult);
      try {
        const expected = { 'worker-model': { ...firstUsage, requests: 1 } };
        for (const id of [traceId, 'another-request']) {
          const result = await parent.agent.process(
            'request',
            testCallOptions({ trace: { traceId: id } }),
          );
          assert.equal(result.ok, false);
          assert.deepEqual(logger.getSummary(id).byModel, expected);
        }
        assert.deepEqual(logger.getSummary().byModel, {
          'worker-model': {
            promptTokens: 34,
            completionTokens: 6,
            totalTokens: 40,
            requests: 2,
          },
        });
      } finally {
        await parent.close();
        if ('close' in worker) await worker.close();
      }
    }
  });
}

test('the pipeline tool loop accounts for error-only retry usage and prefers each reported model bucket', async () => {
  const logger = new SessionRequestLogger();
  const byModel = {
    'first-model': { ...firstUsage, cachedInputTokens: 2, requests: 2 },
    'second-model': { ...secondUsage, requests: 1 },
  };
  let calls = 0;
  const llm = new RetryLlm(
    {
      ...unusedLlm,
      model: 'answer-model',
      async *streamChat(_messages, _tools, options) {
        assert.equal(options?.includeStreamRetryUsage, true);
        calls++;
        if (calls === 1) {
          yield {
            ok: false,
            error: Object.assign(new LlmError('retry before streaming'), {
              status: 503,
              model: 'error-model',
              usage: plannerUsage,
            }),
          };
        } else if (calls === 2) {
          yield {
            ok: true,
            value: { content: 'discarded', usage: firstUsage },
          };
          yield {
            ok: false,
            error: Object.assign(new LlmError('retry stream'), {
              model: 'ignored-flat-model',
              usage: firstUsage,
              usageByModel: byModel,
            }),
          };
        } else {
          yield {
            ok: true,
            value: {
              content: 'answer',
              finishReason: 'stop',
              usage: finalizerUsage,
            },
          };
        }
      },
    },
    { backoffMs: 0, retryOnMidStream: ['retry stream'] },
  );
  const handle = await builder()
    .withMainLlm(llm)
    .build()
    .then(unwrapBuilderResult);
  const parent = await dagWorker(
    new SmartAgentSubAgent('worker', handle.agent),
    logger,
    {
      name: 'passthrough',
      async finalize(input) {
        return { output: input.interpreterOutput };
      },
    },
  );
  try {
    const result = await parent.agent.process(
      'request',
      testCallOptions({ trace: { traceId } }),
    );
    assert.ok(result.ok);
    assert.equal(calls, 3);
    assert.equal(result.value.usage?.totalTokens, 101);
    const expected = {
      ...byModel,
      'answer-model': { ...finalizerUsage, requests: 1 },
      'error-model': { ...plannerUsage, requests: 1 },
    };
    assert.deepEqual(result.value.usage?.models, expected);
    assert.deepEqual(logger.getSummary(traceId).byModel, expected);
    assert.deepEqual(logger.getSummary().byModel, expected);
  } finally {
    await parent.close();
    await handle.close();
  }
});

for (const mode of ['adaptive', 'dag'] as const) {
  test(`${mode} attributes finalizer retries to the model used by each attempt`, async () => {
    const logger = new SessionRequestLogger();
    let attempt = 0;
    const llm = new RetryLlm(
      {
        ...unusedLlm,
        get model() {
          return attempt < 4 ? 'retry-model' : 'answer-model';
        },
        async *streamChat() {
          attempt++;
          if (attempt === 1) {
            yield {
              ok: false,
              error: Object.assign(new LlmError('retry before streaming'), {
                status: 503,
                model: 'error-model',
                usageByModel: {
                  'error-model': { ...plannerUsage, requests: 2 },
                },
              }),
            };
          } else if (attempt < 4) {
            yield {
              ok: true,
              value: { content: 'discarded ', usage: firstUsage },
            };
            yield { ok: false, error: new LlmError('retry stream') };
          } else {
            yield {
              ok: true,
              value: { content: 'answer', usage: secondUsage },
            };
          }
        },
      },
      { backoffMs: 0, retryOnMidStream: ['retry stream'] },
    );
    const synthesizer = new LlmFinalizer(llm);
    const workers = new Map<string, ISubAgent>([
      [
        'worker',
        {
          name: 'worker',
          capabilities: { contextPolicy: 'optional' },
          run: async () => ({ output: 'worker answer' }),
        },
      ],
    ]);
    const parentBuilder = builder()
      .withMainLlm(unusedLlm)
      .withRequestLogger(logger);
    if (mode === 'adaptive') {
      parentBuilder.withStepperCoordinator(
        new AdaptiveCoordinatorHandler({
          workers,
          finalizer: synthesizer,
          controller: {
            name: 'controller',
            async plan() {
              return {
                plan: {
                  createdAt: 0,
                  steps: [{ kind: 'answer', id: 'answer', text: 'draft' }],
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
        finalizer: synthesizer,
        planner: {
          name: 'planner',
          async plan() {
            return {
              plan: {
                createdAt: 0,
                nodes: [{ id: 'work', goal: 'draft', worker: 'worker' }],
              },
            };
          },
        },
        interpreter: new DagPlanInterpreter(),
      });
    }
    const parent = await parentBuilder.build().then(unwrapBuilderResult);
    try {
      const result = await parent.agent.process(
        'request',
        testCallOptions({ trace: { traceId } }),
      );
      assert.ok(result.ok, result.ok ? undefined : result.error.message);
      assert.equal(attempt, 4);
      const expected = {
        'error-model': { ...plannerUsage, requests: 2 },
        'retry-model': {
          promptTokens: 34,
          completionTokens: 6,
          totalTokens: 40,
          requests: 2,
        },
        'answer-model': { ...secondUsage, requests: 1 },
      };
      assert.deepEqual(result.value.usage?.models, expected);
      assert.deepEqual(logger.getSummary(traceId).byModel, expected);
      assert.deepEqual(logger.getSummary().byModel, expected);
      assert.equal(result.value.content, 'answer');
    } finally {
      await parent.close();
    }
  });
}

test('DAG finalizer cancellation before retry counts only the started attempt', async () => {
  let calls = 0;
  const logger = new SessionRequestLogger();
  const controller = new AbortController();
  const llm = new RetryLlm(
    {
      ...unusedLlm,
      model: 'retry-model',
      async *streamChat() {
        calls++;
        yield { ok: true, value: { content: 'discarded', usage: firstUsage } };
        yield { ok: false, error: new LlmError('retry stream') };
      },
    },
    { backoffMs: 0, retryOnMidStream: ['retry stream'] },
  );
  const finalizer = new LlmFinalizer(llm);
  const parent = await dagWorker(
    {
      name: 'worker',
      capabilities: { contextPolicy: 'optional' },
      async run() {
        return { output: 'draft' };
      },
    },
    logger,
    {
      name: finalizer.name,
      finalize(input) {
        return finalizer.finalize({
          ...input,
          onPartial(chunk) {
            if (chunk.kind === 'iteration-end' && chunk.outcome === 'retry')
              controller.abort();
            input.onPartial?.(chunk);
          },
        });
      },
    },
  );
  try {
    const result = await parent.agent.process(
      'request',
      testCallOptions({
        signal: controller.signal,
        trace: { traceId },
      }),
    );
    assert.equal(result.ok, false);
    assert.equal(calls, 1);
    const expected = { 'retry-model': { ...firstUsage, requests: 1 } };
    assert.deepEqual(logger.getSummary(traceId).byModel, expected);
    assert.deepEqual(logger.getSummary().byModel, expected);
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
        assert.deepEqual(parentLogger.getSummary().byModel, expected);
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

test('loggers deduplicate ids and count distinct calls with identical usage', () => {
  const call: LlmCallRecord = {
    callId: 'first-call',
    component: 'tool-loop',
    model: 'worker',
    ...firstUsage,
    durationMs: 0,
  };
  for (const logger of [
    new DefaultRequestLogger(),
    new SessionRequestLogger(),
  ]) {
    logger.startRequest(traceId);
    logger.logLlmCall(call);
    logger.logLlmCall({ ...call, requestId: traceId });
    logger.logLlmCall({ ...call, callId: 'second-call', requestId: traceId });
    const expected = {
      worker: {
        promptTokens: 34,
        completionTokens: 6,
        totalTokens: 40,
        requests: 2,
      },
    };
    assert.deepEqual(logger.getSummary(traceId).byModel, expected);
    assert.deepEqual(logger.getSummary().byModel, expected);
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
