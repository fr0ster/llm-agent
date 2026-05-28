/**
 * Task C4: assert that each handler modified in C3 actually stamps
 * `requestId === ctx.options.trace.traceId` on its log entries.
 *
 * Each block builds a minimal PipelineContext (or LlmClassifier instance)
 * with a RecordingLogger, drives the handler with `options.trace.traceId`
 * set, and asserts every recorded entry carries that traceId.
 *
 * These would have FAILED before C3 (entries had `requestId === undefined`)
 * and now PASS after C3.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  CallOptions,
  ILlm,
  IQueryEmbedding,
  IRag,
  IRequestLogger,
  LlmCallEntry,
  LlmError,
  LlmResponse,
  LlmStreamChunk,
  LlmTool,
  Message,
  RagError,
  RagQueryEntry,
  RagResult,
  RequestSummary,
  Result,
  ToolCallEntry,
} from '@mcp-abap-adt/llm-agent';
import { NoopToolCache } from '@mcp-abap-adt/llm-agent';
import { LlmClassifier } from '../../../classifier/llm-classifier.js';
import { SessionRequestLogger } from '../../../logger/session-request-logger.js';
import { PendingToolResultsRegistry } from '../../../policy/pending-tool-results-registry.js';
import { ToolAvailabilityRegistry } from '../../../policy/tool-availability-registry.js';
import type { ISpan } from '../../../tracer/types.js';
import type { PipelineContext } from '../../context.js';
import { RagQueryHandler } from '../rag-query.js';
import { SummarizeHandler } from '../summarize.js';
import { ToolLoopHandler } from '../tool-loop.js';
import { TranslateHandler } from '../translate.js';

// ---------------------------------------------------------------------------
// RecordingLogger — captures exactly what each handler stamps.
// ---------------------------------------------------------------------------

class RecordingLogger implements IRequestLogger {
  llm: LlmCallEntry[] = [];
  rag: (RagQueryEntry & { requestId?: string })[] = [];
  tool: (ToolCallEntry & { requestId?: string })[] = [];
  logLlmCall(e: LlmCallEntry): void {
    this.llm.push(e);
  }
  logRagQuery(e: RagQueryEntry & { requestId?: string }): void {
    this.rag.push(e);
  }
  logToolCall(e: ToolCallEntry & { requestId?: string }): void {
    this.tool.push(e);
  }
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

// ---------------------------------------------------------------------------
// Generic test helpers
// ---------------------------------------------------------------------------

function makeSpan(): ISpan {
  return {
    name: 's',
    setAttribute() {},
    setStatus() {},
    addEvent() {},
    end() {},
  } as unknown as ISpan;
}

function makeChatLlm(
  response: Partial<LlmResponse> & { content?: string },
): ILlm {
  return {
    model: 'test-model',
    async chat(): Promise<Result<LlmResponse, LlmError>> {
      return {
        ok: true,
        value: {
          content: response.content ?? '',
          finishReason: 'stop',
          usage: response.usage ?? {
            promptTokens: 1,
            completionTokens: 2,
            totalTokens: 3,
          },
        } as LlmResponse,
      };
    },
    async *streamChat(): AsyncIterable<Result<LlmStreamChunk, LlmError>> {
      // Not used by translate / classifier / rag-query tests
    },
  };
}

// ---------------------------------------------------------------------------
// translate handler
// ---------------------------------------------------------------------------

test('translate stamps requestId = ctx.options.trace.traceId', async () => {
  const rec = new RecordingLogger();
  const traceId = 'trace-tr';
  // Non-ASCII text longer than 15 chars to force the translation path
  const ragText = 'привіт як справи там у тебе все добре';
  const llm = makeChatLlm({ content: 'hello how are you' });
  const ctx = {
    ragText,
    isAscii: false,
    helperLlm: llm,
    mainLlm: llm,
    config: {} as PipelineContext['config'],
    requestLogger: rec,
    options: { trace: { traceId } } as CallOptions,
  } as unknown as PipelineContext;

  const ok = await new TranslateHandler().execute(ctx, {}, makeSpan());
  assert.equal(ok, true);
  assert.equal(rec.llm.length, 1, 'translate logged exactly one LLM call');
  assert.equal(
    rec.llm[0].requestId,
    traceId,
    'translate entry carries the traceId',
  );
});

// ---------------------------------------------------------------------------
// rag-query handler
// ---------------------------------------------------------------------------

function makeStore(): IRag {
  return {
    async query(
      _embedding: IQueryEmbedding,
      _k: number,
      _opts?: CallOptions,
    ): Promise<Result<RagResult[], RagError>> {
      return {
        ok: true,
        value: [
          {
            text: 'snippet',
            score: 0.5,
            metadata: { id: 'doc-1' },
          } as RagResult,
        ],
      };
    },
    async upsert(): Promise<Result<void, RagError>> {
      return { ok: true, value: undefined };
    },
    async healthCheck(): Promise<Result<void, RagError>> {
      return { ok: true, value: undefined };
    },
  };
}

test('rag-query stamps requestId = ctx.options.trace.traceId', async () => {
  const rec = new RecordingLogger();
  const traceId = 'trace-rq';
  const ctx = {
    ragText: 'how do I do X',
    toolQueryText: undefined,
    ragStores: { docs: makeStore() },
    queryEmbedding: undefined,
    embedder: undefined,
    options: { trace: { traceId } } as CallOptions,
    sessionId: 's',
    config: { ragQueryK: 3 } as PipelineContext['config'],
    metrics: {
      ragQueryCount: { add() {} },
    } as unknown as PipelineContext['metrics'],
    requestLogger: rec,
    ragResults: {},
  } as unknown as PipelineContext;

  const ok = await new RagQueryHandler().execute(
    ctx,
    { store: 'docs' },
    makeSpan(),
  );
  assert.equal(ok, true);
  assert.ok(rec.rag.length >= 1, 'rag-query logged at least one rag entry');
  assert.ok(
    rec.rag.every((e) => e.requestId === traceId),
    'every rag-query entry carries the traceId',
  );
});

// ---------------------------------------------------------------------------
// classifier
// ---------------------------------------------------------------------------

test('classifier stamps requestId = options.trace.traceId', async () => {
  const rec = new RecordingLogger();
  const traceId = 'trace-cl';
  const fakeLlm = makeChatLlm({
    content: JSON.stringify([
      {
        type: 'chat',
        text: 'hi',
        context: 'general',
        dependency: 'independent',
      },
    ]),
  });
  const classifier = new LlmClassifier(fakeLlm, undefined, rec);
  const result = await classifier.classify('hello there', {
    trace: { traceId },
  });
  assert.equal(result.ok, true);
  assert.equal(rec.llm.length, 1, 'classifier logged exactly one LLM call');
  assert.equal(
    rec.llm[0].requestId,
    traceId,
    'classifier entry carries the traceId',
  );
});

// ---------------------------------------------------------------------------
// tool-loop handler
// ---------------------------------------------------------------------------

/** Yields a single 'stop' chunk with usage so tool-loop completes immediately. */
async function* finalAnswerStream(): AsyncIterable<
  Result<LlmStreamChunk, LlmError>
> {
  yield {
    ok: true,
    value: {
      content: 'final answer',
      finishReason: 'stop',
      usage: {
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
      },
    } as LlmStreamChunk,
  };
}

test('tool-loop stamps requestId = ctx.options.trace.traceId', async () => {
  const rec = new RecordingLogger();
  const traceId = 'trace-tl';

  const mainLlm: ILlm = {
    model: 'tl-model',
    async chat(): Promise<Result<LlmResponse, LlmError>> {
      return {
        ok: true,
        value: { content: '', finishReason: 'stop' } as LlmResponse,
      };
    },
    streamChat: finalAnswerStream,
  };

  const yielded: Result<LlmStreamChunk, unknown>[] = [];
  const ctx = {
    config: {
      maxIterations: 3,
      maxToolCalls: 5,
      heartbeatIntervalMs: 5000,
      mode: 'smart',
    } as PipelineContext['config'],
    options: { trace: { traceId } } as CallOptions,
    sessionId: 's-tl',
    mainLlm,
    inputText: '',
    history: [] as Message[],
    assembledMessages: [{ role: 'user', content: 'hi' } as Message],
    activeTools: [] as LlmTool[],
    externalTools: [] as LlmTool[],
    selectedTools: [] as LlmTool[],
    mcpTools: [],
    toolClientMap: new Map(),
    ragStores: {},
    timing: [],
    pendingToolResults: new PendingToolResultsRegistry(),
    toolAvailabilityRegistry: new ToolAvailabilityRegistry(),
    requestLogger: rec,
    metrics: {
      llmCallCount: { add() {} },
      llmCallLatency: { record() {} },
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
      call: () => finalAnswerStream(),
    } as unknown as PipelineContext['llmCallStrategy'],
    yield(chunk: Result<LlmStreamChunk, unknown>) {
      yielded.push(chunk);
    },
  } as unknown as PipelineContext;

  const ok = await new ToolLoopHandler().execute(ctx, {}, makeSpan());
  assert.equal(ok, true, 'tool-loop completed');
  assert.ok(rec.llm.length >= 1, 'tool-loop logged at least one LLM call');
  assert.ok(
    rec.llm.every((e) => e.requestId === traceId),
    'every tool-loop entry carries the traceId',
  );
  assert.ok(yielded.length >= 1, 'tool-loop yielded at least once');
});

// ---------------------------------------------------------------------------
// summarize handler (Fix #15: helper-LLM history-summarization call must
// stamp requestId so the per-traceId delta accounts for the helper tokens).
// ---------------------------------------------------------------------------

test('summarize stamps requestId = ctx.options.trace.traceId', async () => {
  const rec = new RecordingLogger();
  const traceId = 'trace-sum';
  // Helper returns a short summary with usage; chat() (non-streaming) is used.
  const helperLlm: ILlm = {
    model: 'helper-model',
    async chat(): Promise<Result<LlmResponse, LlmError>> {
      return {
        ok: true,
        value: {
          content: 'short summary',
          finishReason: 'stop',
          usage: {
            promptTokens: 7,
            completionTokens: 3,
            totalTokens: 10,
          },
        } as LlmResponse,
      };
    },
    async *streamChat(): AsyncIterable<Result<LlmStreamChunk, LlmError>> {},
  };
  // History must exceed `limit` (default 10) AND have >=6 messages so
  // `toSummarize = history.slice(0, -5)` is non-empty.
  const history: Message[] = Array.from({ length: 12 }, (_, i) => ({
    role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
    content: `msg-${i}`,
  }));

  const ctx = {
    history,
    helperLlm,
    config: {} as PipelineContext['config'],
    requestLogger: rec,
    options: { trace: { traceId } } as CallOptions,
  } as unknown as PipelineContext;

  const ok = await new SummarizeHandler().execute(ctx, {}, makeSpan());
  assert.equal(ok, true);
  assert.equal(rec.llm.length, 1, 'summarize logged exactly one helper call');
  assert.equal(
    rec.llm[0].requestId,
    traceId,
    'summarize entry carries the traceId',
  );
});

// ---------------------------------------------------------------------------
// tool-loop handler — Fix #16: when a tool actually runs, the logToolCall
// entry must carry requestId so `getSummary(traceId).toolCalls > 0`.
// ---------------------------------------------------------------------------

test('tool-loop logToolCall stamps requestId — per-traceId toolCalls > 0', async () => {
  const traceId = 'trace-tool-exec';
  // Use the REAL SessionRequestLogger so we can assert the per-traceId delta.
  const sessionLogger = new SessionRequestLogger();
  sessionLogger.startRequest(traceId);

  // Iteration 1: stream a tool_call (id, name, args), finishReason=tool_calls.
  // Iteration 2: stream final 'stop' so the loop terminates.
  let iter = 0;
  async function* iterStream(): AsyncIterable<
    Result<LlmStreamChunk, LlmError>
  > {
    iter++;
    if (iter === 1) {
      yield {
        ok: true,
        value: {
          content: '',
          toolCalls: [
            {
              index: 0,
              id: 'call-1',
              name: 'echo',
              arguments: '{"x":1}',
            },
          ],
        } as LlmStreamChunk,
      };
      yield {
        ok: true,
        value: {
          content: '',
          finishReason: 'tool_calls',
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        } as LlmStreamChunk,
      };
      return;
    }
    yield {
      ok: true,
      value: {
        content: 'done',
        finishReason: 'stop',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      } as LlmStreamChunk,
    };
  }

  const mainLlm: ILlm = {
    model: 'tl-model',
    async chat(): Promise<Result<LlmResponse, LlmError>> {
      return {
        ok: true,
        value: { content: '', finishReason: 'stop' } as LlmResponse,
      };
    },
    streamChat: iterStream,
  };

  // Tool client returns ok content.
  const fakeClient = {
    async listTools() {
      return { ok: true as const, value: [] };
    },
    async callTool() {
      return {
        ok: true as const,
        value: { content: 'tool-ok' },
      };
    },
  };

  const yielded: Result<LlmStreamChunk, unknown>[] = [];
  const ctx = {
    config: {
      maxIterations: 3,
      maxToolCalls: 5,
      heartbeatIntervalMs: 5000,
      mode: 'smart',
      refreshToolsPerIteration: false,
    } as PipelineContext['config'],
    options: { trace: { traceId } } as CallOptions,
    sessionId: 's-tool-exec',
    mcpClients: [],
    mainLlm,
    inputText: '',
    history: [] as Message[],
    assembledMessages: [{ role: 'user', content: 'hi' } as Message],
    activeTools: [
      { name: 'echo', description: 'echo', inputSchema: {} } as LlmTool,
    ],
    externalTools: [] as LlmTool[],
    selectedTools: [
      { name: 'echo', description: 'echo', inputSchema: {} } as LlmTool,
    ],
    mcpTools: [{ name: 'echo' }],
    toolClientMap: new Map([['echo', fakeClient]]),
    toolCache: new NoopToolCache(),
    ragStores: {},
    timing: [],
    pendingToolResults: new PendingToolResultsRegistry(),
    toolAvailabilityRegistry: new ToolAvailabilityRegistry(),
    requestLogger: sessionLogger,
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
      ) => iterStream(),
    } as unknown as PipelineContext['llmCallStrategy'],
    yield(chunk: Result<LlmStreamChunk, unknown>) {
      yielded.push(chunk);
    },
  } as unknown as PipelineContext;

  const ok = await new ToolLoopHandler().execute(ctx, {}, makeSpan());
  assert.equal(ok, true, 'tool-loop completed');

  const summary = sessionLogger.getSummary(traceId);
  assert.ok(
    summary.toolCalls > 0,
    `per-traceId toolCalls > 0 (got ${summary.toolCalls})`,
  );
  // Sanity: cumulative also reflects the call.
  assert.ok(sessionLogger.getSummary().toolCalls > 0);
  sessionLogger.dropRequest(traceId);
});
