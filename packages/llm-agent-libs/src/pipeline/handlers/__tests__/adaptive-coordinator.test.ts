import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  AdaptivePlan,
  ControllerPlanInput,
  IAdaptiveController,
  ISubAgentInput,
  LlmStreamChunk,
  Message,
} from '@mcp-abap-adt/llm-agent';
import { SmartAgentBuilder } from '../../../builder.js';
import { InMemoryRunRecordStore } from '../../../coordinator/adaptive/in-memory-run-record-store.js';
import { LlmAdaptiveController } from '../../../coordinator/adaptive/llm-adaptive-controller.js';
import { DefaultPipeline } from '../../default-pipeline.js';
import { pipelineToStream } from '../../pipeline-to-stream.js';
import { AdaptiveCoordinatorHandler } from '../adaptive-coordinator.js';

for (const mode of [
  'answer',
  'throw',
  'invalid',
  'ask',
  'external',
  'save-fail',
  'load-fail',
  'finalize',
  'streamed',
  'stopped',
] as const) {
  test(`adaptive pipeline: ${mode}`, async () => {
    const inputs: ControllerPlanInput[] = [];
    const workers: ISubAgentInput[] = [];
    const logs: string[] = [];
    let finalized = 0;
    const store = new InMemoryRunRecordStore();
    const controller: IAdaptiveController = {
      name: 'controller',
      async plan(input) {
        inputs.push(input);
        if (mode === 'throw') throw new Error('offline');
        if (mode === 'invalid')
          return new LlmAdaptiveController({
            async chat() {
              return { ok: true, value: { content: 'not JSON' } };
            },
            async *streamChat() {
              yield { ok: true, value: { content: '' } };
            },
          }).plan(input);
        const plan: AdaptivePlan = {
          createdAt: 0,
          spec: { objective: 'objective', raw: '' },
          steps:
            mode === 'ask'
              ? [{ id: 'q', kind: 'ask', question: 'Which?' }]
              : mode === 'stopped'
                ? [{ id: 'w', kind: 'work', goal: 'do', worker: 'executor' }]
                : [
                    { id: 'w', kind: 'work', goal: 'do', worker: 'executor' },
                    { id: 'a', kind: 'answer', from: 'w' },
                  ],
        };
        return { plan };
      },
      async check() {
        return { verdict: { verdict: 'pass', reason: 'ok' } };
      },
      async revise() {
        return { steps: [] };
      },
      async report() {
        return { text: 'Stopped report' };
      },
    };
    const handler = new AdaptiveCoordinatorHandler({
      controller,
      workers: new Map([
        [
          'executor',
          {
            name: 'executor',
            description: 'Executes',
            async run(input) {
              workers.push(input);
              if (mode === 'streamed')
                input.onPartial?.({ kind: 'content', delta: 'Hello' });
              return {
                output: 'Hello',
                ...(mode === 'external'
                  ? {
                      status: 'awaiting-external' as const,
                      pendingExternalToolCalls: [
                        { id: 'ext:1', name: 'lookup', arguments: { q: 'x' } },
                      ],
                    }
                  : {}),
              };
            },
          },
        ],
      ]),
      runRecords: {
        load: async (id) => {
          if (mode === 'load-fail') throw new Error('load');
          return store.load(id);
        },
        save: async (id, record) => {
          if (mode === 'save-fail') throw new Error('save');
          return store.save(id, record);
        },
      },
      finalizer: {
        name: 'finalizer',
        streamsInterpreterContent: true,
        async finalize(input) {
          finalized++;
          assert.equal(input.interpreterContentStreamed, mode === 'streamed');
          assert.equal(
            input.objective,
            mode === 'throw' || mode === 'invalid' ? input.prompt : 'objective',
          );
          if (!input.interpreterContentStreamed)
            input.onPartial?.({
              kind: 'content',
              delta: input.interpreterOutput,
            });
          return { output: input.interpreterOutput };
        },
      },
    });
    const pipeline = new DefaultPipeline({ stepperCoordinator: handler });
    const handle = await new SmartAgentBuilder({ skipModelValidation: true })
      .withMainLlm({
        async chat() {
          throw new Error('unexpected LLM');
        },
        async *streamChat() {
          yield { ok: true as const, value: { content: 'unexpected' } };
          throw new Error('unexpected LLM');
        },
      })
      .withClassification(false)
      .setPipeline(pipeline)
      .withStepperCoordinator(handler)
      .build();
    const chunks: LlmStreamChunk[] = [];
    const prior: Message[] = [
      { role: 'user', content: 'old' },
      { role: 'assistant', content: 'reply' },
    ];
    const options = {
      sessionId: 'session',
      sessionLogger: {
        logStep(key: string) {
          logs.push(key);
        },
      },
    };
    for await (const chunk of pipelineToStream(
      pipeline,
      [...prior, { role: 'user', content: 'request' }],
      [],
      options as never,
    )) {
      assert.equal(chunk.ok, true);
      if (chunk.ok) chunks.push(chunk.value);
    }
    assert.deepEqual(inputs[0]?.history, prior);
    if (workers.length) assert.deepEqual(workers[0]?.history, prior);
    assert.deepEqual(inputs[0]?.workers, [
      { name: 'executor', description: 'Executes' },
    ]);
    assert.equal(
      chunks.map((c) => c.content).join(''),
      mode === 'ask'
        ? 'Which?'
        : mode === 'stopped'
          ? 'Stopped report'
          : mode === 'external'
            ? ''
            : 'Hello',
    );
    assert.ok(chunks.some((c) => c.status && c.content === ''));
    assert.equal(
      chunks.at(-1)?.finishReason,
      mode === 'external' ? 'tool_calls' : 'stop',
    );
    assert.equal(
      finalized,
      ['ask', 'external', 'stopped'].includes(mode) ? 0 : 1,
    );
    if (mode === 'external')
      assert.deepEqual(chunks.find((c) => c.toolCalls)?.toolCalls, [
        { index: 0, id: 'ext:1', name: 'lookup', arguments: '{"q":"x"}' },
      ]);
    if (mode === 'throw' || mode === 'invalid')
      assert.ok(logs.includes('adaptive_plan_fallback'));
    if (mode === 'save-fail')
      assert.ok(logs.includes('adaptive_record_save_failed'));
    if (mode === 'load-fail')
      assert.ok(logs.includes('adaptive_record_load_failed'));
    assert.ok(logs.includes('adaptive_plan'));
    assert.ok(logs.includes('adaptive_run'));
    const saved = await store.load('session');
    if (mode !== 'save-fail') {
      assert.equal(
        saved?.plan.spec?.raw,
        mode === 'throw' || mode === 'invalid' ? undefined : 'request',
      );
      assert.ok(saved?.runId);
    }
    const response = await handle.agent.process('next', options as never);
    assert.equal(response.ok, true);
    assert.ok(!inputs[1]?.history.some((m) => m.content === 'next'));
    if (mode !== 'save-fail' && mode !== 'load-fail')
      assert.equal(
        inputs[1]?.previousRun?.outcome,
        mode === 'ask'
          ? 'asked'
          : mode === 'external'
            ? 'awaiting-external'
            : mode === 'stopped'
              ? 'stopped'
              : 'answered',
      );
    await handle.close();
  });
}

for (const form of ['messages', 'string'] as const) {
  test(`process history empirically: ${form}`, async () => {
    const observed: Message[][] = [];
    let planned: Message[] = [];
    const handler = new AdaptiveCoordinatorHandler({
      workers: new Map(),
      controller: {
        name: 'literal',
        async plan(input) {
          planned = input.history;
          return {
            plan: {
              createdAt: 0,
              steps: [{ id: 'a', kind: 'answer', text: 'Hi' }],
            },
          };
        },
        async check() {
          throw new Error('unused');
        },
        async revise() {
          throw new Error('unused');
        },
        async report() {
          throw new Error('unused');
        },
      },
    });
    const handle = await new SmartAgentBuilder({ skipModelValidation: true })
      .withMainLlm({
        async chat() {
          throw new Error('unused');
        },
        async *streamChat() {
          yield { ok: true as const, value: { content: 'unused' } };
        },
      })
      .withClassification(false)
      .withStepperCoordinator({
        async execute(ctx, config, span) {
          observed.push([...ctx.history]);
          return handler.execute(ctx, config, span);
        },
      })
      .build();
    const prior: Message[] = [
      { role: 'user', content: 'old' },
      { role: 'assistant', content: 'reply' },
    ];
    const current: Message = { role: 'user', content: 'request' };
    const result = await handle.agent.process(
      form === 'messages' ? [...prior, current] : 'request',
    );
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value.content, 'Hi');
    assert.deepEqual(observed, [
      form === 'messages' ? [...prior, current] : [],
    ]);
    assert.deepEqual(planned, form === 'messages' ? prior : []);
    await handle.close();
  });
}

for (const abort of [false, true]) {
  test(`interpreter throw is surfaced: abort=${abort}`, async () => {
    const failure = abort
      ? new DOMException('cancelled', 'AbortError')
      : new Error('unexpected');
    const handler = new AdaptiveCoordinatorHandler({
      workers: new Map(),
      controller: {
        name: 'literal',
        async plan() {
          return {
            plan: {
              createdAt: 0,
              steps: [{ id: 'a', kind: 'answer', text: 'Hi' }],
            },
          };
        },
        async check() {
          throw new Error('unused');
        },
        async revise() {
          throw new Error('unused');
        },
        async report() {
          throw new Error('unused');
        },
      },
    });
    const ctx = {
      inputText: 'request',
      history: [],
      yield() {
        throw failure;
      },
      error: undefined,
    } as unknown as Parameters<AdaptiveCoordinatorHandler['execute']>[0];
    assert.equal(await handler.execute(ctx, {}, {} as never), false);
    assert.equal(ctx.error?.message, failure.message);
    assert.equal(
      ctx.error?.code,
      abort ? 'ABORTED' : 'COORDINATOR_STEP_FAILED',
    );
  });
}

for (const live of [false, true]) {
  test(`without finalizer emits answer once: live=${live}`, async () => {
    const chunks: LlmStreamChunk[] = [];
    const handler = new AdaptiveCoordinatorHandler({
      workers: new Map([
        [
          'executor',
          {
            name: 'executor',
            async run(input) {
              if (live) input.onPartial?.({ kind: 'content', delta: 'Hello' });
              return { output: 'Hello' };
            },
          },
        ],
      ]),
      controller: {
        name: 'controller',
        async plan() {
          return {
            plan: {
              createdAt: 0,
              steps: [
                { id: 'w', kind: 'work', goal: 'do', worker: 'executor' },
                { id: 'a', kind: 'answer', from: 'w' },
              ],
            },
          };
        },
        async check() {
          throw new Error('unused');
        },
        async revise() {
          throw new Error('unused');
        },
        async report() {
          throw new Error('unused');
        },
      },
    });
    const ctx = {
      inputText: 'request',
      history: [],
      yield(chunk: { ok: true; value: LlmStreamChunk }) {
        chunks.push(chunk.value);
      },
    } as unknown as Parameters<AdaptiveCoordinatorHandler['execute']>[0];
    assert.equal(await handler.execute(ctx, {}, {} as never), true);
    assert.equal(chunks.map((c) => c.content).join(''), 'Hello');
    assert.equal(chunks.at(-1)?.finishReason, 'stop');
  });
}

const tokenUsage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };
function regressionContext(signal?: AbortSignal) {
  const chunks: LlmStreamChunk[] = [];
  const logged: { component: string; totalTokens: number }[] = [];
  const ctx = {
    inputText: 'request',
    history: [],
    options: { signal },
    requestLogger: {
      logLlmCall(value: (typeof logged)[number]) {
        logged.push(value);
      },
    },
    yield(chunk: { ok: true; value: LlmStreamChunk }) {
      chunks.push(chunk.value);
    },
  } as unknown as Parameters<AdaptiveCoordinatorHandler['execute']>[0];
  return { ctx, chunks, logged };
}
function regressionController(
  steps: AdaptivePlan['steps'],
): IAdaptiveController {
  return {
    name: 'test',
    async plan() {
      return { plan: { steps, createdAt: 0 } };
    },
    async check() {
      return { verdict: { verdict: 'pass', reason: 'ok' } };
    },
    async revise() {
      return { steps: [] };
    },
    async report() {
      return { text: 'stop report' };
    },
  };
}

test('abort during pending report sets ABORTED without successful terminal chunk', async () => {
  const abort = new AbortController();
  const { ctx, chunks } = regressionContext(abort.signal);
  const controller = regressionController([]);
  let release!: () => void;
  let entered!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reporting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  controller.report = async () => {
    entered();
    await pending;
    throw new Error('report failed');
  };
  const running = new AdaptiveCoordinatorHandler({
    controller,
    workers: new Map(),
  }).execute(ctx, {}, {} as never);
  await reporting;
  abort.abort();
  release();
  assert.equal(await running, false);
  assert.equal(ctx.error?.code, 'ABORTED');
  assert.ok(!chunks.some((chunk) => chunk.finishReason));
});

for (const method of ['plan', 'check', 'revise'] as const) {
  test(`${method} parse error usage logged once on fallback`, async () => {
    const { ctx, chunks, logged } = regressionContext();
    const steps: AdaptivePlan['steps'] =
      method === 'check'
        ? [
            {
              id: 'c',
              kind: 'check',
              goal: 'check',
              worker: 'self',
              targets: [],
              onPass: 'next',
              onFail: 'next',
            },
            { id: 'a', kind: 'answer', text: 'answer' },
          ]
        : [{ id: 'r', kind: 'revise', reason: 'revise' }];
    const controller = regressionController(steps);
    const invalid = new LlmAdaptiveController({
      async chat() {
        return { ok: true, value: { content: 'invalid', usage: tokenUsage } };
      },
      async *streamChat() {
        yield { ok: true, value: { content: 'unused' } };
      },
    });
    controller[method] = invalid[method].bind(
      invalid,
    ) as (typeof controller)[typeof method];
    const handler = new AdaptiveCoordinatorHandler({
      controller,
      workers: new Map([
        [
          'executor',
          {
            name: 'executor',
            async run() {
              return { output: 'fallback answer' };
            },
          },
        ],
      ]),
    });
    assert.equal(await handler.execute(ctx, {}, {} as never), true);
    assert.equal(logged.length, 1);
    assert.equal(
      logged[0]?.component,
      method === 'check' ? 'reviewer' : 'planner',
    );
    assert.equal(logged[0]?.totalTokens, 15);
    assert.equal(
      chunks.map((chunk) => chunk.content).join(''),
      method === 'plan'
        ? 'fallback answer'
        : method === 'check'
          ? 'answer'
          : 'stop report',
    );
  });
}

for (const selfLogs of [false, true]) {
  test(`worker usage follows DAG ownership: selfLogs=${selfLogs}`, async () => {
    const { ctx, logged } = regressionContext();
    const controller = regressionController([
      { id: 'w', kind: 'work', goal: 'work', worker: 'executor' },
      { id: 'a', kind: 'answer', from: 'w' },
    ]);
    const handler = new AdaptiveCoordinatorHandler({
      controller,
      workers: new Map([
        [
          'executor',
          {
            name: 'executor',
            async run() {
              if (selfLogs)
                ctx.requestLogger.logLlmCall({
                  component: 'executor',
                  model: 'worker',
                  ...tokenUsage,
                  durationMs: 0,
                });
              return { output: 'answer', usage: tokenUsage };
            },
          },
        ],
      ]),
    });
    assert.equal(await handler.execute(ctx, {}, {} as never), true);
    assert.equal(logged.length, selfLogs ? 1 : 0);
  });
}

for (const mode of [
  'answer',
  'ask',
  'stop',
  'finalized',
  'external',
] as const) {
  test(`semantic history stores visible text: ${mode}`, async () => {
    const { ctx } = regressionContext();
    const steps: AdaptivePlan['steps'] =
      mode === 'ask'
        ? [{ id: 'q', kind: 'ask', question: 'question?' }]
        : mode === 'stop'
          ? []
          : mode === 'external'
            ? [{ id: 'w', kind: 'work', goal: 'work', worker: 'executor' }]
            : [{ id: 'a', kind: 'answer', text: 'answer' }];
    const handler = new AdaptiveCoordinatorHandler({
      controller: regressionController(steps),
      workers: new Map([
        [
          'executor',
          {
            name: 'executor',
            async run() {
              return {
                output: 'internal',
                status: 'awaiting-external' as const,
              };
            },
          },
        ],
      ]),
      ...(mode === 'finalized'
        ? {
            finalizer: {
              name: 'final',
              async finalize(input) {
                input.onPartial?.({ kind: 'content', delta: 'final answer' });
                return { output: 'final answer' };
              },
            },
          }
        : {}),
    });
    assert.equal(await handler.execute(ctx, {}, {} as never), true);
    assert.equal(
      ctx.assistantText,
      mode === 'external'
        ? undefined
        : mode === 'finalized'
          ? 'final answer'
          : mode === 'ask'
            ? 'question?'
            : mode === 'stop'
              ? 'stop report'
              : 'answer',
    );
  });
}

for (const mode of ['listed', 'mixed', 'thrown'] as const) {
  test(`explicit worker usage ownership: ${mode}`, async () => {
    const { ctx, logged } = regressionContext();
    const steps: AdaptivePlan['steps'] = [
      { id: 'w', kind: 'work', goal: 'work', worker: 'executor' },
      ...(mode === 'mixed'
        ? [
            {
              id: 's',
              kind: 'work' as const,
              goal: 'work',
              worker: 'self-logger',
            },
          ]
        : []),
      { id: 'a', kind: 'answer', from: 'w' },
    ];
    const handler = new AdaptiveCoordinatorHandler({
      logWorkerUsage: new Set(['executor']),
      controller: regressionController(steps),
      workers: new Map([
        [
          'executor',
          {
            name: 'executor',
            async run() {
              if (mode === 'thrown')
                throw Object.assign(new Error('failed'), { usage: tokenUsage });
              return {
                output: 'answer',
                usage: tokenUsage,
                metadata: { model: 'returned-model' },
              };
            },
          },
        ],
        [
          'self-logger',
          {
            name: 'self-logger',
            async run() {
              ctx.requestLogger.logLlmCall({
                component: 'executor',
                model: 'own',
                ...tokenUsage,
                durationMs: 0,
              });
              return { output: 'done', usage: tokenUsage };
            },
          },
        ],
      ]),
    });
    assert.equal(await handler.execute(ctx, {}, {} as never), true);
    assert.equal(logged.length, mode === 'mixed' ? 2 : 1);
    assert.equal(logged[0]?.totalTokens, 15);
    assert.equal(logged[0]?.component, 'executor');
    assert.equal(
      (logged[mode === 'mixed' ? 1 : 0] as unknown as { model: string }).model,
      mode === 'thrown' ? 'unknown' : 'returned-model',
    );
  });
}

for (const kind of ['work', 'check'] as const) {
  test(`epicfail ${kind} stops before branching and saves failure`, async () => {
    const { ctx, chunks, logged } = regressionContext();
    ctx.sessionId = 'fatal';
    const store = new InMemoryRunRecordStore();
    const trace = {
      stepId: 'nested',
      agentName: 'worker',
      attempts: [],
      originalError: 'fatal cause',
    };
    let calls = 0;
    const controller = regressionController([
      kind === 'work'
        ? { id: 'fatal', kind, goal: 'work', worker: 'executor' }
        : {
            id: 'fatal',
            kind,
            goal: 'check',
            worker: 'executor',
            targets: [],
            onPass: 'next',
            onFail: 'fatal',
          },
      { id: 'a', kind: 'answer', text: 'must not answer' },
    ]);
    controller.report = async () => {
      throw new Error('must not report');
    };
    const handler = new AdaptiveCoordinatorHandler({
      controller,
      runRecords: store,
      logWorkerUsage: new Set(['executor']),
      workers: new Map([
        [
          'executor',
          {
            name: 'executor',
            async run() {
              calls++;
              return {
                output: 'fatal output',
                errorClass: 'epicfail' as const,
                epicFailTrace: trace,
                usage: tokenUsage,
              };
            },
          },
        ],
      ]),
    });
    assert.equal(await handler.execute(ctx, {}, {} as never), false);
    assert.equal(calls, 1);
    assert.equal(ctx.error?.code, 'COORDINATOR_STEP_FAILED');
    assert.deepEqual(
      (ctx.error as unknown as { epicFailTrace: unknown }).epicFailTrace,
      trace,
    );
    assert.ok(!chunks.some((chunk) => chunk.finishReason));
    assert.ok(!chunks.some((chunk) => chunk.content === 'must not answer'));
    const saved = await store.load('fatal');
    assert.equal(saved?.outcome, 'stopped');
    assert.equal(saved?.stopReason, 'step fatal epicfail');
    assert.equal(saved?.steps[0]?.status, 'failed');
    assert.equal(logged.length, 1);
  });
}
