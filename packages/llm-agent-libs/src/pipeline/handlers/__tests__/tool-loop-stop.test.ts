import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  CallOptions,
  ILlm,
  IMcpClient,
  IRequestLogger,
  LlmCallEntry,
  LlmError,
  LlmResponse,
  LlmStreamChunk,
  LlmTool,
  Message,
  OnPartial,
  RagQueryEntry,
  RequestSummary,
  Result,
  ToolCallEntry,
} from '@mcp-abap-adt/llm-agent';
import { NoopToolCache } from '@mcp-abap-adt/llm-agent';
import { SmartAgent } from '../../../agent.js';
import { PendingToolResultsRegistry } from '../../../policy/pending-tool-results-registry.js';
import { ToolAvailabilityRegistry } from '../../../policy/tool-availability-registry.js';
import { makeAssembler, makeDefaultDeps } from '../../../testing/index.js';
import type { ISpan } from '../../../tracer/types.js';
import type { PipelineContext } from '../../context.js';
import { ToolLoopHandler } from '../tool-loop.js';

class NoopLogger implements IRequestLogger {
  logLlmCall(_e: LlmCallEntry): void {}
  logRagQuery(_e: RagQueryEntry): void {}
  logToolCall(_e: ToolCallEntry): void {}
  startRequest(): void {}
  endRequest(): void {}
  dropRequest(): void {}
  getSummary(): RequestSummary {
    return {
      byModel: {},
      byComponent: {},
      byCategory: {},
      ragQueries: 0,
      toolCalls: 0,
      totalDurationMs: 0,
    };
  }
  reset(): void {}
}

function makeSpan(): ISpan {
  return {
    name: 's',
    setAttribute() {},
    setStatus() {},
    addEvent() {},
    end() {},
  } as unknown as ISpan;
}

/** Builds a minimal PipelineContext that makes ToolLoopHandler run one
 *  iteration and emit content deltas, then stop. */
function makeCtx(
  streamFn: () => AsyncIterable<Result<LlmStreamChunk, LlmError>>,
  onPartial?: OnPartial,
): PipelineContext {
  const mainLlm: ILlm = {
    model: 'stub-model',
    async chat(): Promise<Result<LlmResponse, LlmError>> {
      return {
        ok: true,
        value: { content: '', finishReason: 'stop' } as LlmResponse,
      };
    },
    streamChat: streamFn,
  };

  const yielded: Result<LlmStreamChunk, unknown>[] = [];

  return {
    config: {
      maxIterations: 3,
      maxToolCalls: 5,
      heartbeatIntervalMs: 5000,
      mode: 'smart',
      refreshToolsPerIteration: false,
    } as PipelineContext['config'],
    options: {} as CallOptions,
    sessionId: 's-stream',
    mcpClients: [],
    mainLlm,
    inputText: '',
    history: [] as Message[],
    assembledMessages: [{ role: 'user', content: 'hi' } as Message],
    activeTools: [] as LlmTool[],
    externalTools: [] as LlmTool[],
    selectedTools: [] as LlmTool[],
    mcpTools: [],
    toolClientMap: new Map(),
    toolCache: new NoopToolCache(),
    ragStores: {},
    timing: [],
    pendingToolResults: new PendingToolResultsRegistry(),
    toolAvailabilityRegistry: new ToolAvailabilityRegistry(),
    requestLogger: new NoopLogger(),
    metrics: {
      llmCallCount: { add() {} },
      llmCallLatency: { record() {} },
      toolCallCount: { add() {} },
      toolCacheHitCount: { add() {} },
    } as unknown as PipelineContext['metrics'],
    tracer: {
      startSpan: () => makeSpan(),
    } as unknown as PipelineContext['tracer'],
    sessionManager: {
      addTokens() {},
      isOverBudget: () => false,
      reset() {},
      totalTokens: 0,
    } as unknown as PipelineContext['sessionManager'],
    outputValidator: {
      async validate() {
        return { ok: true, value: { valid: true } };
      },
    } as unknown as PipelineContext['outputValidator'],
    llmCallStrategy: {
      call: (
        _llm: ILlm,
        _msgs: Message[],
        _tools: LlmTool[],
        _opts?: CallOptions,
      ) => streamFn(),
    } as unknown as PipelineContext['llmCallStrategy'],
    onPartial,
    yield(chunk: Result<LlmStreamChunk, unknown>) {
      yielded.push(chunk);
    },
  } as unknown as PipelineContext;
}

for (const mode of ['stop', 'hard', 'none', 'pre-stopped']) {
  test(`cooperative boundary: ${mode}`, async () => {
    const stop = new AbortController();
    const hard = new AbortController();
    if (mode === 'pre-stopped') stop.abort();
    let calls = 0;
    let completed = false;
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const base = makeCtx(async function* () {
      calls++;
      yield {
        ok: true,
        value:
          calls === 1
            ? {
                content: 'partial',
                toolCalls: [{ id: 'c1', name: 'Work', arguments: {} }],
                finishReason: 'tool_calls',
              }
            : { content: 'final', finishReason: 'stop' },
      };
    });
    const ctx = {
      ...base,
      options: {
        signal: hard.signal,
        ...(mode !== 'none' ? { stopSignal: stop.signal } : {}),
      },
    } as PipelineContext;
    ctx.toolClientMap.set('Work', {
      async listTools() {
        return { ok: true, value: [] };
      },
      async callTool(_name, _args, options) {
        started();
        await gate;
        assert.equal(options?.signal?.aborted, mode === 'hard');
        completed = true;
        return { ok: true, value: { content: 'done' } };
      },
    });
    const chunks: Result<LlmStreamChunk, unknown>[] = [];
    ctx.yield = (chunk) => {
      chunks.push(chunk);
    };
    const running = new ToolLoopHandler().execute(
      ctx,
      { heartbeatIntervalMs: 0 },
      makeSpan(),
    );
    await entered;
    if (mode === 'hard') hard.abort();
    stop.abort();
    assert.equal(completed, false, 'in-flight tool still waiting');
    release();
    assert.equal(await running, mode !== 'hard');
    assert.equal(completed, true, 'tool completed normally');
    assert.equal(calls, mode === 'none' ? 2 : 1);
    const last = chunks.at(-1);
    assert.ok(last);
    if (mode === 'hard') {
      assert.equal(last.ok, false);
      if (!last.ok)
        assert.equal((last.error as { code: string }).code, 'ABORTED');
    } else {
      assert.equal(last.ok, true);
      if (last.ok) assert.equal(last.value.finishReason, 'stop');
      if (last.ok)
        assert.equal(last.value.stopped, mode === 'none' ? undefined : true);
      assert.equal(
        chunks
          .filter((c) => c.ok && !c.value.ephemeral)
          .map((c) => (c.ok ? c.value.content : ''))
          .join(''),
        mode === 'none' ? 'partialfinal' : 'partial',
      );
    }
  });
}

for (const streamMode of ['full', 'final'] as const) {
  for (const pipeline of [false, true]) {
    test(`SmartAgent.process preserves partial output with normal stop reason and stopped marker (pipeline=${pipeline}, streamMode=${streamMode})`, async () => {
      const stop = new AbortController();
      let calls = 0;
      const stream = async function* (): AsyncIterable<
        Result<LlmStreamChunk, LlmError>
      > {
        calls++;
        yield {
          ok: true,
          value: {
            content: 'partial',
            toolCalls: [{ id: 'c1', name: 'Work', arguments: {} }],
            finishReason: 'tool_calls',
          },
        };
      };
      const client: IMcpClient = {
        async listTools() {
          return {
            ok: true,
            value: [{ name: 'Work', description: 'work', inputSchema: {} }],
          };
        },
        async callTool(_name, _args, options) {
          assert.equal(options?.signal?.aborted, false);
          stop.abort();
          return { ok: true, value: { content: 'done' } };
        },
      };
      const base = makeCtx(stream);
      const { deps } = makeDefaultDeps({
        assembler: makeAssembler([{ role: 'user', content: 'work' }]),
        mcpClients: [client],
      });
      deps.mainLlm = base.mainLlm;
      let detected = false;
      if (!pipeline)
        deps.clientAdapters = [
          {
            name: 'test',
            detect(prompt: string) {
              detected = prompt === 'adapter';
              return detected;
            },
            wrapResponse(content: string) {
              return `[${content}]`;
            },
          },
        ];
      if (pipeline) {
        deps.pipeline = {
          initialize() {},
          async execute(_input, _history, options, yieldChunk) {
            assert.equal(options?.stopSignal, stop.signal);
            const ctx = { ...base, options, yield: yieldChunk };
            ctx.toolClientMap.set('Work', client);
            await new ToolLoopHandler().execute(
              ctx,
              { heartbeatIntervalMs: 0 },
              makeSpan(),
            );
            return { timing: ctx.timing };
          },
        };
      }
      const agent = new SmartAgent(deps, {
        streamMode,
        maxIterations: 3,
        heartbeatIntervalMs: 0,
      });
      const result = await agent.process(
        [
          { role: 'system', content: 'adapter' },
          { role: 'user', content: 'work' },
        ],
        {
          stopSignal: stop.signal,
          signal: new AbortController().signal,
        },
      );
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.value.content, pipeline ? 'partial' : '[partial]');
        assert.equal(detected, !pipeline);
        assert.equal(result.value.stopReason, 'stop');
        assert.equal(result.value.stopped, true);
      }
      assert.equal(calls, 1);
    });
  }
}

for (const pipeline of [false, true]) {
  for (const scenario of ['budget30', 'boundary', 'mixed']) {
    test(`complete tool rounds: ${scenario} (pipeline=${pipeline})`, async () => {
      const limit = scenario === 'boundary' ? 1 : 30;
      const rounds = scenario === 'budget30' ? 4 : 1;
      const size = scenario === 'budget30' ? 8 : 2;
      let requests = 0;
      let executed = 0;
      let budgetErrors = 0;
      const validate = (messages: Message[]) => {
        for (let i = 0; i < messages.length; i++) {
          const calls = messages[i].tool_calls;
          if (!calls?.length) continue;
          const results: Message[] = [];
          while (messages[i + 1]?.role === 'tool') results.push(messages[++i]);
          assert.deepEqual(
            results.map((r) => r.tool_call_id).sort(),
            calls.map((c) => c.id).sort(),
          );
        }
      };
      const stream = async function* (
        messages: Message[],
        tools?: LlmTool[],
      ): AsyncIterable<Result<LlmStreamChunk, LlmError>> {
        validate(messages);
        requests++;
        if (requests <= rounds) {
          yield {
            ok: true,
            value: {
              content: '',
              finishReason: 'tool_calls',
              toolCalls: Array.from({ length: size }, (_, index) => ({
                index,
                id: `${requests}-${index}`,
                name: scenario === 'mixed' && index === 1 ? 'Ghost' : 'Work',
                arguments: JSON.stringify({ id: `${requests}-${index}` }),
              })),
            },
          };
        } else {
          budgetErrors = messages.filter(
            (m) =>
              m.role === 'tool' &&
              String(m.content).includes('not executed: tool-call budget'),
          ).length;
          if (scenario !== 'mixed') assert.deepEqual(tools, []);
          else
            assert.ok(
              messages.some(
                (m) =>
                  m.role === 'tool' && String(m.content).includes('not found'),
              ),
            );
          yield { ok: true, value: { content: 'done', finishReason: 'stop' } };
        }
      };
      const client: IMcpClient = {
        async listTools() {
          return {
            ok: true,
            value: [
              {
                name: 'Work',
                description: 'work',
                inputSchema: { type: 'object' },
              },
            ],
          };
        },
        async callTool() {
          executed++;
          return { ok: true, value: { content: 'ok' } };
        },
      };
      const base = makeCtx(async function* () {});
      base.mainLlm.streamChat = stream;
      base.config.maxIterations = 8;
      base.config.maxToolCalls = limit;
      base.llmCallStrategy = {
        call: (_llm, messages, tools) => stream(messages, tools),
      } as PipelineContext['llmCallStrategy'];
      const { deps } = makeDefaultDeps({
        assembler: makeAssembler([{ role: 'user', content: 'work' }]),
        mcpClients: [client],
      });
      deps.mainLlm = base.mainLlm;
      if (pipeline) {
        deps.pipeline = {
          initialize() {},
          async execute(_input, _history, options, yieldChunk) {
            const ctx = { ...base, options, yield: yieldChunk };
            ctx.toolClientMap.set('Work', client);
            await new ToolLoopHandler().execute(
              ctx,
              { heartbeatIntervalMs: 0 },
              makeSpan(),
            );
            return { timing: ctx.timing };
          },
        };
      }
      const agent = new SmartAgent(deps, {
        maxIterations: 8,
        maxToolCalls: limit,
        heartbeatIntervalMs: 0,
      });
      const result = await agent.process('work');
      assert.equal(result.ok, true);
      assert.equal(requests, rounds + 1);
      assert.equal(executed, scenario === 'budget30' ? 30 : 1);
      assert.equal(
        budgetErrors,
        scenario === 'budget30' ? 2 : scenario === 'boundary' ? 1 : 0,
      );
    });
  }
}

test('summarize keeps an eight-result round intact across the recent boundary', async () => {
  const { SummarizeHandler } = await import('../summarize.js');
  const ctx = makeCtx(async function* () {});
  const calls = Array.from({ length: 8 }, (_, i) => ({
    id: `s${i}`,
    type: 'function' as const,
    function: { name: 'Work', arguments: '{}' },
  }));
  const round: Message[] = [
    { role: 'assistant', content: null, tool_calls: calls },
    ...calls.map((c) => ({
      role: 'tool' as const,
      tool_call_id: c.id,
      content: 'ok',
    })),
  ];
  ctx.history = [
    { role: 'user', content: 'old' },
    { role: 'assistant', content: 'old reply' },
    ...round,
    { role: 'assistant', content: 'done' },
  ];
  ctx.helperLlm = {
    async chat(messages: Message[]) {
      assert.deepEqual(messages.slice(0, -1), ctx.history.slice(0, 2));
      return { ok: true, value: { content: 'summary', finishReason: 'stop' } };
    },
  } as ILlm;
  await new SummarizeHandler().execute(ctx, { limit: 5 }, makeSpan());
  assert.deepEqual(ctx.history.slice(1), [
    ...round,
    { role: 'assistant', content: 'done' },
  ]);
});

for (const maxToolCalls of [1, 5]) {
  for (const throws of [false, true]) {
    test(`pipeline reports tools offered (budget=${maxToolCalls}, throws=${throws})`, async () => {
      let rounds = 0;
      const reports: number[][] = [];
      const offered: number[] = [];
      const ctx = makeCtx(async function* () {
        rounds++;
        yield {
          ok: true,
          value:
            rounds === 1
              ? {
                  content: '',
                  toolCalls: [
                    { index: 0, id: 't', name: 'Read', arguments: '{}' },
                  ],
                  finishReason: 'tool_calls',
                }
              : { content: 'done', finishReason: 'stop' },
        };
      });
      ctx.mcpTools = ['Read', 'Write', 'Delete'].map((name) => ({
        name,
        description: name,
        inputSchema: { type: 'object' },
      }));
      ctx.activeTools = [
        { name: 'Read', description: 'read', inputSchema: { type: 'object' } },
      ];
      ctx.toolClientMap.set('Read', {
        async listTools() {
          return { ok: true, value: ctx.mcpTools };
        },
        async callTool() {
          return { ok: true, value: { content: 'ok' } };
        },
      });
      const strategy = ctx.llmCallStrategy;
      ctx.llmCallStrategy = {
        call(llm, messages, tools, options) {
          offered.push(tools.length);
          return strategy.call(llm, messages, tools, options);
        },
      };
      ctx.options = {
        onToolsSelected(selected, available) {
          reports.push([selected, available]);
          if (throws) throw new Error('observer failed');
        },
      };
      await new ToolLoopHandler().execute(ctx, { maxToolCalls }, makeSpan());
      assert.equal(rounds, 2);
      assert.deepEqual(offered, maxToolCalls === 1 ? [1, 0] : [1, 1]);
      assert.deepEqual(
        reports,
        maxToolCalls === 1
          ? [
              [1, 3],
              [0, 3],
            ]
          : [[1, 3]],
      );
    });
  }
}
