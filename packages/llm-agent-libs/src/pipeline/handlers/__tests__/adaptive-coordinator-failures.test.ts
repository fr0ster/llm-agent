import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type AdaptiveStep,
  EMBEDDING_CONTEXT_EXCEEDED,
  type IAdaptiveController,
  type ILlm,
  type ISubAgent,
  LlmError,
  MODEL_CONTEXT_EXCEEDED,
  RagError,
} from '@mcp-abap-adt/llm-agent';
import { SmartAgentBuilder } from '../../../builder.js';
import { unwrapBuilderResult } from '../../../builder-types.js';
import { LlmAdaptiveController } from '../../../coordinator/adaptive/llm-adaptive-controller.js';
import { DefaultRequestLogger } from '../../../logger/default-request-logger.js';
import { DirectLlmSubAgent } from '../../../subagent/direct-llm-subagent.js';
import { testCallOptions, testRequestAccess } from '../../../testing/index.js';
import { AdaptiveCoordinatorHandler } from '../adaptive-coordinator.js';

const adaptiveSteps = {
  plan: { id: 'answer', kind: 'answer', text: 'answer' },
  check: {
    id: 'check',
    kind: 'check',
    worker: 'self',
    goal: 'Check',
    targets: [],
    onPass: 'end',
    onFail: 'end',
  },
  revise: { id: 'revise', kind: 'revise', reason: 'Revise' },
  report: { id: 'work', kind: 'work', worker: 'executor', goal: 'Work' },
  worker: { id: 'work', kind: 'work', worker: 'executor', goal: 'Work' },
} satisfies Record<string, AdaptiveStep>;

const usage = { promptTokens: 1, completionTokens: 2, totalTokens: 3 };

function buildAdaptiveAgent(
  plan: IAdaptiveController['plan'],
  run?: ISubAgent['run'],
  logger = new DefaultRequestLogger(),
) {
  const worker: ISubAgent | undefined = run && {
    name: 'executor',
    capabilities: { contextPolicy: 'optional' },
    run,
  };
  return new SmartAgentBuilder({ skipModelValidation: true })
    .withRagAccess(testRequestAccess)
    .withMainLlm({
      chat: async () => assert.fail('unexpected chat'),
      streamChat: () => assert.fail('unexpected stream'),
    })
    .withRequestLogger(logger)
    .withClassification(false)
    .withStepperCoordinator(
      new AdaptiveCoordinatorHandler({
        controller: {
          name: 'custom',
          plan,
          check: async () => assert.fail('unexpected check'),
          revise: async () => assert.fail('unexpected revision'),
          report: async () => assert.fail('unexpected report'),
        },
        workers: new Map(worker ? [[worker.name, worker]] : []),
      }),
    )
    .build()
    .then(unwrapBuilderResult);
}

for (const role of ['plan', 'check', 'revise', 'report', 'worker'] as const) {
  for (const failure of [
    'truncated',
    'CREDENTIALS_REJECTED',
    'LLM_TRANSPORT_FAILED',
    'ABORTED',
  ] as const) {
    test(`adaptive ${role} surfaces ${failure} through the agent`, async () => {
      const providerError = new LlmError('Provider rejected the run', failure);
      const plan = JSON.stringify({ steps: [adaptiveSteps[role]] });
      let calls = 0;
      let workerRuns = 0;
      const fail: ILlm['chat'] = async () =>
        failure === 'truncated'
          ? { ok: true, value: { content: plan, finishReason: 'length' } }
          : { ok: false, error: providerError };
      const worker = new DirectLlmSubAgent(
        'executor',
        {
          chat: fail,
          streamChat: () => assert.fail('unexpected worker stream'),
        },
        { systemPrompt: '', contextPolicy: 'optional' },
      );
      const controller = new LlmAdaptiveController({
        async chat() {
          calls++;
          if (role !== 'plan' && calls === 1)
            return { ok: true, value: { content: plan, finishReason: 'stop' } };
          assert.notEqual(role, 'worker', 'worker errors must skip the report');
          return fail([]);
        },
        streamChat: () => assert.fail('unexpected stream'),
      });
      const handle = await new SmartAgentBuilder({ skipModelValidation: true })
        .withRagAccess(testRequestAccess)
        .withMainLlm({
          chat: async () => assert.fail('unexpected chat'),
          streamChat: () => assert.fail('unexpected stream'),
        })
        .withClassification(false)
        .withStepperCoordinator(
          new AdaptiveCoordinatorHandler({
            controller,
            workers: new Map([
              [
                'executor',
                {
                  name: 'executor',
                  capabilities: { contextPolicy: 'optional' },
                  async run(input) {
                    workerRuns++;
                    if (role === 'worker') return worker.run(input);
                    return { output: 'work done' };
                  },
                },
              ],
            ]),
          }),
        )
        .build()
        .then(unwrapBuilderResult);
      try {
        const result = await handle.agent.process('request', testCallOptions());
        assert.equal(
          workerRuns,
          role === 'report' || role === 'worker' ? 1 : 0,
        );
        assert.equal(calls, role === 'plan' || role === 'worker' ? 1 : 2);
        assert.equal(result.ok, false);
        assert.equal(
          result.error.code,
          failure === 'truncated' ? 'LLM_OUTPUT_TRUNCATED' : failure,
        );
        if (failure !== 'truncated') {
          if (role === 'worker' || role === 'check' || role === 'revise')
            assert.equal(result.error.cause, providerError);
          else assert.equal(result.error, providerError);
        }
      } finally {
        await handle.close();
      }
    });
  }
}

test('adaptive planning exposes overflow when the planner also aborts', async () => {
  const abort = new AbortController();
  const overflow = new LlmError('Prompt too long', MODEL_CONTEXT_EXCEEDED);
  const controller = new LlmAdaptiveController({
    async chat() {
      abort.abort();
      return { ok: false, error: overflow };
    },
    streamChat: () => assert.fail('unexpected stream'),
  });
  const handle = await new SmartAgentBuilder({ skipModelValidation: true })
    .withRagAccess(testRequestAccess)
    .withMainLlm({
      chat: async () => assert.fail('unexpected chat'),
      streamChat: () => assert.fail('unexpected stream'),
    })
    .withClassification(false)
    .withStepperCoordinator(
      new AdaptiveCoordinatorHandler({ controller, workers: new Map() }),
    )
    .build()
    .then(unwrapBuilderResult);
  try {
    const result = await handle.agent.process('Work', {
      ...testCallOptions(),
      signal: abort.signal,
    });
    assert.ok(!result.ok);
    assert.equal(result.error, overflow);
  } finally {
    await handle.close();
  }
});

test('adaptive planning exposes embedding overflow when a custom planner also aborts', async () => {
  const abort = new AbortController();
  const overflow = new RagError(
    'Embedding input exceeds context length',
    EMBEDDING_CONTEXT_EXCEEDED,
  );
  const handle = await new SmartAgentBuilder({ skipModelValidation: true })
    .withRagAccess(testRequestAccess)
    .withMainLlm({
      chat: async () => assert.fail('unexpected chat'),
      streamChat: () => assert.fail('unexpected stream'),
    })
    .withClassification(false)
    .withStepperCoordinator(
      new AdaptiveCoordinatorHandler({
        controller: {
          name: 'custom',
          async plan() {
            abort.abort();
            throw new Error('Planner context lookup failed', {
              cause: overflow,
            });
          },
          check: async () => assert.fail('unexpected check'),
          revise: async () => assert.fail('unexpected revision'),
          report: async () => assert.fail('unexpected report'),
        },
        workers: new Map(),
      }),
    )
    .build()
    .then(unwrapBuilderResult);
  try {
    const result = await handle.agent.process(
      'Work',
      testCallOptions({ signal: abort.signal }),
    );
    assert.ok(!result.ok);
    assert.equal(result.error, overflow);
  } finally {
    await handle.close();
  }
});

for (const withUsage of [false, true]) {
  test(`adaptive planning classifies a coded abort reason as ABORTED (usage=${withUsage})`, async (t) => {
    const abort = new AbortController();
    const reason = new LlmError('Cancelled', MODEL_CONTEXT_EXCEEDED);
    if (withUsage) Object.assign(reason, { usage });
    const handle = await buildAdaptiveAgent(async ({ signal }) => {
      abort.abort(reason);
      signal?.throwIfAborted();
      return assert.fail('expected cancellation');
    });
    t.after(() => handle.close());

    const result = await handle.agent.process(
      'Work',
      testCallOptions({ signal: abort.signal }),
    );
    assert.ok(!result.ok);
    assert.equal(result.error.code, 'ABORTED');
    assert.equal(result.error.message, reason.message);
  });
}

for (const mode of [
  'thrown',
  'returned',
  'both fields',
  'nested overflow',
] as const) {
  test(`adaptive worker meters failure usage once (${mode})`, async (t) => {
    const logger = new DefaultRequestLogger();
    const error = Object.assign(
      new RagError('Worker failed', 'QUERY_ERROR', {
        cause:
          mode === 'nested overflow'
            ? new LlmError('Prompt too long', MODEL_CONTEXT_EXCEEDED)
            : undefined,
      }),
      { usage },
    );
    const handle = await buildAdaptiveAgent(
      async () => ({ plan: { steps: [adaptiveSteps.worker], createdAt: 0 } }),
      async () => {
        if (mode === 'thrown') throw error;
        return {
          output: '',
          error,
          ...(mode === 'both fields' && { usage }),
        };
      },
      logger,
    );
    t.after(() => handle.close());

    const result = await handle.agent.process('Work', testCallOptions());
    assert.ok(!result.ok);
    assert.equal(
      result.error.code,
      mode === 'nested overflow' ? MODEL_CONTEXT_EXCEEDED : 'QUERY_ERROR',
    );
    const { totals } = logger.getSummary();
    assert.equal(totals.totalTokens, 3);
    assert.equal(totals.requests, 1);
    assert.deepEqual(
      result.error.usageCalls?.map(({ callId, totalTokens }) => ({
        callId,
        totalTokens,
      })),
      logger.usageCalls.map(({ callId, totalTokens }) => ({
        callId,
        totalTokens,
      })),
    );
    assert.equal(error.usageCalls, undefined);
  });
}
