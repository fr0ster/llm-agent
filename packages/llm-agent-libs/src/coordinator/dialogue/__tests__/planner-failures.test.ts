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
  SmartAgentError,
} from '@mcp-abap-adt/llm-agent';
import { SmartAgent } from '../../../agent.js';
import { SmartAgentBuilder } from '../../../builder.js';
import { unwrapBuilderResult } from '../../../builder-types.js';
import { RetryLlm } from '../../../resilience/retry-llm.js';
import {
  makeDefaultDeps,
  makeRag,
  testCallOptions,
  testRequestAccess,
} from '../../../testing/index.js';
import { DialogueSession } from '../dialogue-session.js';
import { InMemoryDialogueStateStore } from '../in-memory-dialogue-state-store.js';
import { retrievePlannerContext } from '../planner-retrieval.js';
import { PlannerToolsClient } from '../planner-tools-client.js';
import { ProfilePlanAuthor } from '../profile-plan-author.js';
import { TaskBoard } from '../task-board.js';
import { profileHost } from './profile-test-host.js';

const tools = new PlannerToolsClient();
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test('dialogue task result storage preserves terminal failure codes', async () => {
  const { caller } = testCallOptions();
  const worker: ISubAgent = {
    name: 'worker',
    capabilities: { contextPolicy: 'optional' },
    async run() {
      return { output: 'Done' };
    },
  };
  const error = new OrchestratorError(
    'Storage configuration is invalid',
    'INVALID_CONFIG',
  );
  const board = new TaskBoard({
    caller,
    workers: new Map([[worker.name, worker]]),
    resultStore: {
      async put() {
        throw error;
      },
      read: () => assert.fail('unexpected read'),
    },
    onEvent() {},
  });
  const started = board.start({ worker: worker.name, goal: 'Work' });
  assert.ok(started.ok);
  await tick();
  assert.equal(board.get(started.value.id)?.state, 'failed');
  assert.equal(board.get(started.value.id)?.terminalErrorCode, error.code);
});

for (const retrieval of ['memory', 'knowledge', 'cancelled'] as const) {
  test(`dialogue planner retrieval preserves terminal failures (${retrieval})`, async () => {
    const error = new LlmError(
      'Access denied',
      retrieval === 'cancelled' ? 'ABORTED' : 'CREDENTIALS_REJECTED',
    );
    const fail = async () => {
      throw error;
    };
    const rag = makeRag();
    rag.query = fail;
    await assert.rejects(
      retrievePlannerContext(
        {
          ...(retrieval === 'memory'
            ? {
                plannerMemory: {
                  rag,
                  queryEmbedder: { embedQuery: async () => ({ vector: [1] }) },
                  documentEmbedder: {
                    embedDocument: async () => ({ vector: [1] }),
                  },
                },
              }
            : { plannerKnowledge: [{ name: 'docs', search: fail }] }),
        },
        's',
        'r',
        'Work',
        false,
        {
          signal:
            retrieval === 'cancelled' ? AbortSignal.abort(error) : undefined,
        },
        () => assert.fail('terminal error must not fall back to empty context'),
      ),
      (caught) => caught === error,
    );
  });
}

test('profile lookup keeps an explicit terminal abort', async () => {
  const { caller } = testCallOptions();
  const host = profileHost(new Map());
  const board = new TaskBoard({ ...host, caller, onEvent() {} });
  const error = new OrchestratorError('Selection aborted', 'ABORTED');
  const result = await board.startTask(
    { worker: 'worker', goal: 'Work' },
    { signal: AbortSignal.abort(error) },
  );
  assert.ok(!result.ok);
  assert.equal(result.terminalError, error);
});

test('a terminal background worker failure stops an active planner before it can re-delegate', async () => {
  const { caller } = testCallOptions();
  let runs = 0;
  let calls = 0;
  const worker: ISubAgent = {
    name: 'executor',
    capabilities: { contextPolicy: 'optional' },
    async run() {
      runs++;
      throw new OrchestratorError('Output truncated', 'LLM_OUTPUT_TRUNCATED');
    },
  };
  const task = { worker: worker.name, goal: 'Work' };
  const session = await DialogueSession.open({
    id: caller.sessionId,
    caller,
    board: { workers: new Map([[worker.name, worker]]) },
    planner: {
      async process(_messages, options) {
        calls++;
        const delegated = await tools.callTool('delegate_task', task);
        assert.ok(delegated.ok && !delegated.value.isError);
        await tick();
        assert.equal(options.stopSignal?.aborted, true);
        const retry = await tools.callTool('delegate_task', task);
        assert.ok(!retry.ok);
        assert.equal(retry.error.code, 'LLM_OUTPUT_TRUNCATED');
        return { ok: true, value: { content: 'Should be discarded' } };
      },
    },
  });
  try {
    await assert.rejects(session.send('Work'), {
      code: 'LLM_OUTPUT_TRUNCATED',
    });
    await tick();
    assert.equal(calls, 1);
    assert.equal(runs, 1);
    assert.equal(session.snapshot().requests?.[0].lastTurnOk, false);
    assert.equal(
      session.snapshot().tasks[0].terminalErrorCode,
      'LLM_OUTPUT_TRUNCATED',
    );
    assert.deepEqual(session.takePending(), []);
  } finally {
    await session.close();
  }
});

test('terminal worker failures bypass the event planner and prevent external retry after restoring the session', async () => {
  const { caller } = testCallOptions();
  let rejectWorker: (error: Error) => void = () =>
    assert.fail('worker did not start');
  const worker: ISubAgent = {
    name: 'executor',
    capabilities: { contextPolicy: 'optional' },
    run() {
      return new Promise((_resolve, reject) => {
        rejectWorker = reject;
      });
    },
  };
  const task = { worker: worker.name, goal: 'Work' };
  let plannerCalls = 0;
  const options = {
    id: caller.sessionId,
    caller,
    board: { workers: new Map([[worker.name, worker]]) },
    planner: {
      async process() {
        if (++plannerCalls === 1) {
          const delegated = await tools.callTool('delegate_task', task);
          assert.ok(delegated.ok && !delegated.value.isError);
        }
        return { ok: true as const, value: { content: 'Waiting' } };
      },
    },
  };
  const session = await DialogueSession.open(options);
  const store = new InMemoryDialogueStateStore();
  try {
    await session.send('Work');
    // The classifier also recognizes authenticated transport failures with a generic code.
    rejectWorker(Object.assign(new LlmError('Rejected'), { status: 401 }));
    await tick();
    assert.equal(plannerCalls, 1);
    const snapshot = session.snapshot();
    assert.equal(snapshot.tasks[0].terminalErrorCode, 'LLM_ERROR');
    await store.save(caller.sessionId, snapshot);
  } finally {
    await session.close();
  }
  const restored = await DialogueSession.open({ ...options, store });
  try {
    const retry = await restored.callTool('delegate_task', task);
    assert.ok(!retry.ok && retry.error instanceof SmartAgentError);
    assert.equal(retry.error.code, 'LLM_ERROR');
    const replan = await restored.callTool('plan_update', {
      plan: 'Try again',
    });
    assert.ok(!replan.ok);
    assert.equal(replan.error.code, 'LLM_ERROR');
    assert.equal(restored.snapshot().tasks.length, 1);
    await restored.send('Independent request');
    assert.equal(plannerCalls, 2);
    assert.equal(restored.snapshot().requests?.length, 2);
  } finally {
    await restored.close();
  }
});

for (const phase of ['selection', 'worker preparation'] as const) {
  test(`dialogue preserves a terminal profile failure during ${phase}`, async () => {
    const { caller } = testCallOptions();
    const worker: ISubAgent = {
      name: 'executor',
      capabilities: { contextPolicy: 'optional' },
      run: () =>
        assert.fail('terminal profile failure must prevent worker execution'),
    };
    const host = profileHost(new Map([[worker.name, worker]]));
    const error = new OrchestratorError('Missing provider', 'MISSING_PROVIDER');
    if (phase === 'selection')
      host.profileSource.list = async () => {
        throw error;
      };
    else
      host.profileRunner.createWorker = async () => {
        throw error;
      };
    const board = new TaskBoard({ ...host, caller, onEvent() {} });
    const task = { worker: worker.name, goal: 'Work' };
    try {
      const started = await board.startTask(task);
      if (phase === 'selection') {
        assert.ok(!started.ok);
        assert.equal(started.terminalError, error);
      } else {
        assert.ok(started.ok);
        await tick();
        assert.equal(
          board.get(started.value.id)?.terminalErrorCode,
          error.code,
        );
        assert.equal(board.get(started.value.id)?.state, 'failed');
      }
    } finally {
      await board.stopAll();
    }
  });
}

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
