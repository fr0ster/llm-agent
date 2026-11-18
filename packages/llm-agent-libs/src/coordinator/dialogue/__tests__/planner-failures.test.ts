import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CircuitBreaker,
  CircuitBreakerLlm,
  FallbackLlmCallStrategy,
  type ILlm,
  type ISubAgent,
  LlmError,
  OrchestratorError,
} from '@mcp-abap-adt/llm-agent';
import { SmartAgent } from '../../../agent.js';
import { SmartAgentBuilder } from '../../../builder.js';
import { unwrapBuilderResult } from '../../../builder-types.js';
import { RetryLlm } from '../../../resilience/retry-llm.js';
import {
  makeDefaultDeps,
  testCallOptions,
  testRequestAccess,
} from '../../../testing/index.js';
import { DialogueSession } from '../dialogue-session.js';
import { PlannerToolsClient } from '../planner-tools-client.js';
import { ProfilePlanAuthor } from '../profile-plan-author.js';
import { profileHost } from './profile-test-host.js';

const tools = new PlannerToolsClient();

for (const mode of [
  'legacy',
  'pipeline result',
  'pipeline throw',
  'circuit',
  'retry',
] as const) {
  test(`dialogue planner preserves the original failure through ${mode}`, async () => {
    const { caller } = testCallOptions();
    const error =
      mode === 'circuit' || mode === 'retry'
        ? new OrchestratorError('Output truncated', 'LLM_OUTPUT_TRUNCATED')
        : new LlmError('Credentials rejected', 'CREDENTIALS_REJECTED');
    let streams = 0;
    let fallbackCalls = 0;
    const transport: ILlm = {
      async chat() {
        fallbackCalls++;
        return {
          ok: true,
          value: { content: 'Fallback reply', finishReason: 'stop' },
        };
      },
      async *streamChat() {
        if (++streams > 1) {
          yield {
            ok: true,
            value: { content: 'Retry reply', finishReason: 'stop' },
          };
          return;
        }
        yield { ok: true, value: { content: 'Partial reply' } };
        if (mode !== 'legacy' && mode !== 'pipeline result') throw error;
        yield { ok: false, error };
      },
    };
    const llm =
      mode === 'retry'
        ? new RetryLlm(transport, {
            backoffMs: 0,
            retryOnMidStream: ['Output truncated'],
          })
        : mode === 'circuit'
          ? new CircuitBreakerLlm(transport, new CircuitBreaker())
          : transport;
    const builder = new SmartAgentBuilder({ skipModelValidation: true })
      .withRagAccess(testRequestAccess)
      .withMainLlm(llm)
      .withClassification(false);
    if (mode === 'circuit')
      builder.withLlmCallStrategy(new FallbackLlmCallStrategy());
    const handle =
      mode === 'legacy'
        ? undefined
        : unwrapBuilderResult(await builder.build());
    const planner =
      handle?.agent ??
      new SmartAgent({ ...makeDefaultDeps().deps, mainLlm: llm }, {});
    const session = await DialogueSession.open({
      id: caller.sessionId,
      caller,
      planner,
      board: { workers: new Map() },
    });
    try {
      await assert.rejects(session.send('Work'), (caught) => caught === error);
      assert.equal(streams, 1);
      assert.equal(fallbackCalls, 0);
    } finally {
      await session.close();
      await handle?.close();
    }
  });
}

for (const fallback of ['wait', 'restart'] as const) {
  for (const mode of ['result', 'throw'] as const) {
    for (const terminal of [true, false]) {
      test(`dialogue ${fallback} handles a ${terminal ? 'terminal' : 'recoverable'} planner ${mode} failure`, async () => {
        const { caller } = testCallOptions();
        const worker: ISubAgent = {
          name: 'executor',
          capabilities: { contextPolicy: 'optional' },
          run({ stopSignal }) {
            return new Promise((resolve) => {
              stopSignal?.addEventListener(
                'abort',
                () => resolve({ output: 'stopped' }),
                { once: true },
              );
            });
          },
        };
        const error = terminal
          ? new LlmError('The planner was aborted', 'ABORTED')
          : new LlmError('Service unavailable', 'LLM_OFFLINE');
        let calls = 0;
        const session = await DialogueSession.open({
          id: caller.sessionId,
          caller,
          maxCorrections: 0,
          board: { workers: new Map([[worker.name, worker]]) },
          planner: {
            async process(_messages, opts) {
              calls++;
              if (fallback === 'restart') {
                if (calls === 1) {
                  await tools.callTool('plan_update', {
                    plan: 'Keep request active',
                  });
                  return { ok: true, value: { content: 'First reply' } };
                }
                if (calls === 3)
                  return { ok: true, value: { content: 'Restart reply' } };
                const started = await tools.callTool('new_request', {});
                assert.ok(started.ok && !started.value.isError);
              } else {
                await tools.callTool('delegate_task', {
                  worker: 'executor',
                  goal: 'Work',
                });
                await tools.callTool('list_tasks', {});
                await tools.callTool('list_tasks', {});
              }
              assert.equal(opts.stopSignal?.aborted, true);
              opts.onPartial?.({ kind: 'content', delta: 'Partial reply' });
              if (mode === 'throw') throw error;
              return { ok: false, error };
            },
          },
        });
        try {
          if (fallback === 'restart') await session.send('First request');
          if (terminal) {
            await assert.rejects(
              session.send('Request'),
              (caught) => caught === error,
            );
          } else {
            assert.equal(
              (await session.send('Request')).text,
              fallback === 'restart' ? 'Restart reply' : 'Partial reply',
            );
          }
          assert.equal(calls, fallback === 'restart' ? (terminal ? 2 : 3) : 1);
        } finally {
          await session.close();
        }
      });
    }
  }
}

for (const mode of ['create', 'revise', 'prepare'] as const) {
  test(`a typed dialogue plan ${mode} failure ends the turn without applying a plan`, async () => {
    const { caller } = testCallOptions();
    const host = profileHost(new Map());
    const plan = '{"steps":[{"id":"s1","goal":"Work"}]}';
    const { deps } = makeDefaultDeps({
      llmResponses: [
        ...(mode === 'revise'
          ? [{ content: plan, finishReason: 'stop' as const }]
          : []),
        { content: plan, finishReason: 'length' },
      ],
    });
    const author = new SmartAgent(deps, {});
    const prepareError = new LlmError(
      'Credentials rejected',
      'CREDENTIALS_REJECTED',
    );
    host.profileRunner.preparePlanAuthor = async () => {
      if (mode === 'prepare') throw prepareError;
      return { ok: true, value: author };
    };
    const planAuthor = new ProfilePlanAuthor({
      source: host.profileSource,
      runner: host.profileRunner,
    });
    let stopRequested = false;
    const session = await DialogueSession.open({
      id: caller.sessionId,
      caller,
      maxCorrections: 0,
      planAuthor,
      board: { workers: new Map() },
      planner: {
        async process(_messages, opts) {
          await (mode === 'revise'
            ? tools.callTool('plan_revise', { change: 'Revise' })
            : tools.callTool('plan_create', { goal: 'Work' }));
          stopRequested = opts.stopSignal?.aborted === true;
          return { ok: true, value: { content: 'Fallback reply' } };
        },
      },
    });
    try {
      if (mode === 'revise') {
        const created = await session.callTool('plan_create', { goal: 'Work' });
        assert.ok(created.ok && !created.value.isError);
      }
      const previous = JSON.stringify(session.snapshot().plan);
      await assert.rejects(session.send('Work'), {
        code: mode === 'prepare' ? prepareError.code : 'LLM_OUTPUT_TRUNCATED',
      });
      assert.equal(stopRequested, true);
      assert.equal(JSON.stringify(session.snapshot().plan), previous);
    } finally {
      await session.close();
    }
  });
}
