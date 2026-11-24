import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type AdaptiveStep,
  type ILlm,
  LlmError,
  MODEL_CONTEXT_EXCEEDED,
} from '@mcp-abap-adt/llm-agent';
import { SmartAgentBuilder } from '../../../builder.js';
import { unwrapBuilderResult } from '../../../builder-types.js';
import { LlmAdaptiveController } from '../../../coordinator/adaptive/llm-adaptive-controller.js';
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
