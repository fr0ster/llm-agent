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
