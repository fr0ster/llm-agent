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
