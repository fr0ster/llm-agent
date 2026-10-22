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

for (const pipeline of [false, true]) {
  test(`SmartAgent.process preserves partial output with normal stop reason and stopped marker (pipeline=${pipeline})`, async () => {
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
      maxIterations: 3,
      heartbeatIntervalMs: 0,
    });
    const result = await agent.process('work', {
      stopSignal: stop.signal,
      signal: new AbortController().signal,
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.content, 'partial');
      assert.equal(result.value.stopReason, 'stop');
      assert.equal(result.value.stopped, true);
    }
    assert.equal(calls, 1);
  });
}
