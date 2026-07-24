/**
 * Task 4 — Worker tool-loop emits deltas via `ctx.onPartial`.
 *
 * Verifies that ToolLoopHandler.execute() forwards every content chunk
 * from the streaming LLM call to `ctx.onPartial` (when present), and
 * that the handler completes silently when `ctx.onPartial` is absent.
 */

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
import { PendingToolResultsRegistry } from '../../../policy/pending-tool-results-registry.js';
import { ToolAvailabilityRegistry } from '../../../policy/tool-availability-registry.js';
import type { ISpan } from '../../../tracer/types.js';
import type { PipelineContext } from '../../context.js';
import { ToolLoopHandler } from '../tool-loop.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('tool-loop emits content deltas via ctx.onPartial when present', async () => {
  async function* multiChunkStream(): AsyncIterable<
    Result<LlmStreamChunk, LlmError>
  > {
    yield { ok: true, value: { content: 'a' } } as Result<
      LlmStreamChunk,
      LlmError
    >;
    yield { ok: true, value: { content: 'b' } } as Result<
      LlmStreamChunk,
      LlmError
    >;
    yield {
      ok: true,
      value: {
        content: 'c',
        finishReason: 'stop',
        usage: { promptTokens: 1, completionTokens: 3, totalTokens: 4 },
      },
    } as Result<LlmStreamChunk, LlmError>;
  }

  const deltas: string[] = [];
  const onPartial: OnPartial = (c) => {
    if (c.kind === 'content') deltas.push(c.delta);
  };

  const ctx = makeCtx(multiChunkStream, onPartial);
  const ok = await new ToolLoopHandler().execute(ctx, {}, makeSpan());

  assert.equal(ok, true, 'tool-loop completed');
  assert.deepEqual(deltas, ['a', 'b', 'c'], 'all content deltas forwarded');
});

test('tool-loop without onPartial does not throw (silent default)', async () => {
  const extraCalls = 0;

  async function* simpleStream(): AsyncIterable<
    Result<LlmStreamChunk, LlmError>
  > {
    yield {
      ok: true,
      value: {
        content: 'hello',
        finishReason: 'stop',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      },
    } as Result<LlmStreamChunk, LlmError>;
  }

  // No onPartial callback provided → ctx.onPartial is undefined.
  const ctx = makeCtx(simpleStream, undefined);
  const ok = await new ToolLoopHandler().execute(ctx, {}, makeSpan());

  assert.equal(ok, true, 'tool-loop completed without onPartial');
  assert.equal(extraCalls, 0, 'no unexpected side effects');
});

// ---------------------------------------------------------------------------
// #246 — disabled heartbeat interval for an INTERNAL (toolClientMap) tool call
// ---------------------------------------------------------------------------

const SLOW_TOOL: LlmTool = {
  type: 'function',
  function: { name: 'Slow', description: 'slow internal tool', parameters: {} },
} as unknown as LlmTool;

/** MCP client stub whose callTool awaits `delayMs` before resolving. */
function slowInternalClient(delayMs: number): IMcpClient {
  return {
    async listTools() {
      return {
        ok: true as const,
        value: [{ name: 'Slow', description: 'slow', inputSchema: {} }],
      };
    },
    async callTool() {
      await new Promise((r) => setTimeout(r, delayMs));
      return { ok: true as const, value: { content: 'slow result' } };
    },
  } as IMcpClient;
}

/** LLM that streams one Slow tool call on round 1, final text on round 2. */
function slowToolThenTextLlm(): ILlm {
  let n = 0;
  async function* stream(): AsyncIterable<Result<LlmStreamChunk, LlmError>> {
    if (++n === 1) {
      yield {
        ok: true,
        value: {
          content: '',
          toolCalls: [{ id: 'c0', name: 'Slow', arguments: {} }],
          finishReason: 'tool_calls',
        },
      } as Result<LlmStreamChunk, LlmError>;
      return;
    }
    yield {
      ok: true,
      value: { content: 'final', finishReason: 'stop' },
    } as Result<LlmStreamChunk, LlmError>;
  }
  return {
    model: 'stub',
    async chat(): Promise<Result<LlmResponse, LlmError>> {
      return { ok: true, value: { content: '', finishReason: 'stop' } };
    },
    streamChat: stream,
  } as ILlm;
}

/** Builds a ctx that drives ToolLoopHandler through an INTERNAL (toolClientMap)
 *  tool call to a slow client, with a configurable heartbeatIntervalMs. */
function makeSlowInternalToolCtx(opts: {
  heartbeatIntervalMs: number;
  toolDelayMs: number;
}): PipelineContext {
  const llm = slowToolThenTextLlm();
  const client = slowInternalClient(opts.toolDelayMs);

  return {
    config: {
      maxIterations: 3,
      maxToolCalls: 5,
      heartbeatIntervalMs: opts.heartbeatIntervalMs,
      mode: 'smart',
      refreshToolsPerIteration: false,
    } as PipelineContext['config'],
    options: {} as CallOptions,
    sessionId: 's-slow-internal',
    mcpClients: [client],
    mainLlm: llm,
    inputText: '',
    history: [] as Message[],
    assembledMessages: [{ role: 'user', content: 'call Slow' } as Message],
    activeTools: [SLOW_TOOL],
    externalTools: [] as LlmTool[],
    selectedTools: [SLOW_TOOL],
    mcpTools: [],
    toolClientMap: new Map<string, IMcpClient>([['Slow', client]]),
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
      call: () => llm.streamChat?.([], [], undefined),
    } as unknown as PipelineContext['llmCallStrategy'],
    yield() {},
  } as unknown as PipelineContext;
}

test('#246 caller #1: ToolLoopHandler with heartbeatIntervalMs 0 → no heartbeat, no busy loop', async () => {
  // ctx built like the file's makeCtx, but with: config.heartbeatIntervalMs = 0;
  // a "Slow" INTERNAL tool in toolClientMap whose callTool awaits ~120ms; and
  // a streamFn that (round 1) yields { toolCalls: [Slow], finishReason: 'tool_calls' }
  // then (round 2) yields final content.
  const ctx = makeSlowInternalToolCtx({
    heartbeatIntervalMs: 0,
    toolDelayMs: 120,
  });

  // Capture what the handler yields to the client stream.
  const captured: Result<LlmStreamChunk, unknown>[] = [];
  (ctx as { yield: (c: Result<LlmStreamChunk, unknown>) => void }).yield = (
    c,
  ) => {
    captured.push(c);
  };

  const started = Date.now();
  const ok = await new ToolLoopHandler().execute(ctx, {}, makeSpan());

  assert.equal(ok, true);
  assert.ok(Date.now() - started < 4000, 'must not busy-loop');
  assert.equal(
    captured.filter(
      (c) =>
        c.ok && (c.value as { heartbeat?: unknown }).heartbeat !== undefined,
    ).length,
    0,
    'disabled interval → no heartbeat chunk from the batch executor',
  );
});
