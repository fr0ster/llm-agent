import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type ILlm,
  type ISubAgent,
  LlmError,
  McpError,
  NeedsDecompositionError,
} from '@mcp-abap-adt/llm-agent';
import { SmartAgentBuilder } from '../../../builder.js';
import { unwrapBuilderResult } from '../../../builder-types.js';
import { LlmFinalizer } from '../../../coordinator/dag/llm-finalizer.js';
import {
  DagPlanInterpreter,
  LlmDagPlanner,
  LlmReviewStrategy,
  ReplanErrorStrategy,
} from '../../../coordinator/index.js';
import { DirectLlmSubAgent } from '../../../subagent/direct-llm-subagent.js';
import { testCallOptions, testRequestAccess } from '../../../testing/index.js';

const plan = '{"nodes":[{"id":"n1","goal":"Work","agent":"executor"}]}';

function chat(respond: ILlm['chat']): ILlm {
  return {
    chat: respond,
    streamChat: () => assert.fail('unexpected stream'),
  };
}

for (const role of [
  'planner',
  'reviewer',
  'replanner',
  'subplan',
  'worker',
  'recovery reviewer',
  'finalizer',
] as const) {
  for (const failure of [
    'truncated',
    'CREDENTIALS_REJECTED',
    'ABORTED',
  ] as const) {
    test(`DAG ${role} surfaces ${failure} through the agent`, async () => {
      const providerError = new LlmError('Provider rejected the run', failure);
      const fail: ILlm['chat'] = async () =>
        failure === 'truncated'
          ? {
              ok: true,
              value: { content: '{"nodes":[]}', finishReason: 'length' },
            }
          : { ok: false, error: providerError };
      let plans = 0;
      let reviews = 0;
      let work = 0;
      let finalizations = 0;
      const planner = new LlmDagPlanner(
        chat(async (...args) => {
          plans++;
          return role === 'planner' || plans > 1
            ? fail(...args)
            : { ok: true, value: { content: plan, finishReason: 'stop' } };
        }),
      );
      const reviewer = new LlmReviewStrategy(
        chat(async (...args) => {
          reviews++;
          if (
            role === 'reviewer' ||
            (role === 'recovery reviewer' && reviews > 1)
          )
            return fail(...args);
          const content =
            role === 'replanner'
              ? '{"pass":false,"feedback":"Revise"}'
              : reviews === 1
                ? '{"pass":true}'
                : `{"action":"revise","plan":${plan}}`;
          return { ok: true, value: { content, finishReason: 'stop' } };
        }),
      );
      const worker = new DirectLlmSubAgent(
        'executor',
        chat(async (...args) => {
          work++;
          if (role === 'worker' && work === 1) return fail(...args);
          if (role === 'subplan')
            throw new NeedsDecompositionError('Split work');
          if (role === 'recovery reviewer')
            throw new Error('Recoverable work failure');
          return { ok: true, value: { content: 'done', finishReason: 'stop' } };
        }),
        { systemPrompt: '', contextPolicy: 'optional' },
      );
      const finalizer = new LlmFinalizer({
        chat: () => assert.fail('unexpected finalizer chat'),
        async *streamChat() {
          finalizations++;
          if (role === 'finalizer') yield await fail([]);
          else yield { ok: true, value: { content: 'done' } };
        },
      });
      const handle = await new SmartAgentBuilder({ skipModelValidation: true })
        .withRagAccess(testRequestAccess)
        .withMainLlm(chat(() => assert.fail('unexpected main LLM')))
        .withClassification(false)
        .withDagCoordinator({
          planner,
          reviewer,
          finalizer,
          interpreter: new DagPlanInterpreter(),
          workers: new Map([[worker.name, worker]]),
          activation: { name: 'test', shouldActivate: () => true },
          errorStrategy: new ReplanErrorStrategy(planner),
        })
        .build()
        .then(unwrapBuilderResult);
      try {
        const result = await handle.agent.process('request', testCallOptions());
        assert.equal(result.ok, false);
        if (failure !== 'truncated') assert.equal(result.error, providerError);
        else assert.equal(result.error.code, 'LLM_OUTPUT_TRUNCATED');
        assert.equal(plans, role === 'replanner' || role === 'subplan' ? 2 : 1);
        assert.equal(
          reviews,
          role === 'planner' ? 0 : role === 'recovery reviewer' ? 2 : 1,
        );
        assert.equal(
          work,
          ['subplan', 'worker', 'recovery reviewer', 'finalizer'].includes(role)
            ? 1
            : 0,
        );
        assert.equal(finalizations, role === 'finalizer' ? 1 : 0);
      } finally {
        await handle.close();
      }
    });
  }
}

test('DAG recovers from an MCP tool error using an alternative worker', async () => {
  const calls: string[] = [];
  let reviews = 0;
  const error = new McpError('Tool failed', 'MCP_ERROR');
  const makeWorker = (name: string, run: ISubAgent['run']): ISubAgent => ({
    name,
    capabilities: { contextPolicy: 'optional' },
    async run(input) {
      calls.push(name);
      return run(input);
    },
  });
  const primary = makeWorker('executor', async () => {
    throw error;
  });
  const alternative = makeWorker('alternative', async () => ({
    output: 'recovered',
  }));
  const handle = await new SmartAgentBuilder({ skipModelValidation: true })
    .withRagAccess(testRequestAccess)
    .withMainLlm(chat(() => assert.fail('unexpected main LLM')))
    .withClassification(false)
    .withDagCoordinator({
      planner: new LlmDagPlanner(
        chat(async () => ({
          ok: true,
          value: { content: plan, finishReason: 'stop' },
        })),
      ),
      reviewer: new LlmReviewStrategy(
        chat(async () => ({
          ok: true,
          value: {
            content:
              ++reviews === 2
                ? `{"action":"revise","plan":${plan.replace('executor', 'alternative')}}`
                : '{"pass":true}',
            finishReason: 'stop',
          },
        })),
      ),
      interpreter: new DagPlanInterpreter(),
      errorStrategy: {
        name: 'record failure',
        async onNodeFailure(_node, failure) {
          assert.equal(failure, error);
          calls.push('recovery');
          return { action: 'abort' };
        },
      },
      workers: new Map([
        [primary.name, primary],
        [alternative.name, alternative],
      ]),
      activation: { name: 'test', shouldActivate: () => true },
    })
    .build()
    .then(unwrapBuilderResult);
  try {
    const result = await handle.agent.process('request', testCallOptions());
    assert.ok(result.ok);
    assert.equal(result.value.content, 'recovered');
    assert.deepEqual(calls, ['executor', 'recovery', 'alternative']);
    assert.equal(reviews, 3);
  } finally {
    await handle.close();
  }
});
