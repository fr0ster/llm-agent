/**
 * Task 11 / Amendment B — MCP tool-call timing is emitted through the
 * existing structured channels:
 *
 *  1. `ILogger.log({ type: 'tool_call', traceId, toolName, isError, durationMs })`
 *     — the already-defined structured event.
 *  2. `ctx.options.sessionLogger.logStep('mcp_tool_call', { toolName, durationMs, isError })`
 *     — the per-session DEBUG channel.
 *
 * Both channels must fire on every tool execution (success AND failure).
 * No console.warn, no env flag, no new logger interface is introduced.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  CallOptions,
  ILlm,
  ILogger,
  IRequestLogger,
  ISessionLogger,
  LlmCallEntry,
  LlmError,
  LlmResponse,
  LlmStreamChunk,
  LlmTool,
  LogEvent,
  McpToolResult,
  Message,
  RagQueryEntry,
  RequestSummary,
  Result,
  ToolCallEntry,
} from '@mcp-abap-adt/llm-agent';
import { McpError, NoopToolCache } from '@mcp-abap-adt/llm-agent';
import { PendingToolResultsRegistry } from '../../../policy/pending-tool-results-registry.js';
import { ToolAvailabilityRegistry } from '../../../policy/tool-availability-registry.js';
import type { ISpan } from '../../../tracer/types.js';
import type { PipelineContext } from '../../context.js';
import { ToolLoopHandler } from '../tool-loop.js';

// ---------------------------------------------------------------------------
// Helpers
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

const TOOL: LlmTool = {
  type: 'function',
  function: { name: 'GetTable', description: 'read table', parameters: {} },
} as unknown as LlmTool;

/** LLM that requests exactly one GetTable tool call, then emits a stop. */
function oneToolThenStop(): ILlm {
  let call = 0;
  async function* stream(): AsyncIterable<Result<LlmStreamChunk, LlmError>> {
    call++;
    if (call === 1) {
      yield {
        ok: true,
        value: {
          content: '',
          toolCalls: [{ id: 'c0', name: 'GetTable', arguments: {} }],
          finishReason: 'tool_calls',
        },
      } as Result<LlmStreamChunk, LlmError>;
      return;
    }
    yield {
      ok: true,
      value: { content: 'done', finishReason: 'stop' },
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

class SpyLogger implements ILogger {
  readonly events: LogEvent[] = [];
  log(event: LogEvent): void {
    this.events.push(event);
  }
}

class SpySessionLogger implements ISessionLogger {
  readonly steps: { name: string; data: unknown }[] = [];
  logStep(name: string, data: unknown): void {
    this.steps.push({ name, data });
  }
}

class NoopRequestLogger implements IRequestLogger {
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

function makeCtx(
  client: { callTool: () => Promise<Result<McpToolResult, McpError>> },
  spyLogger: SpyLogger,
  spySession: SpySessionLogger,
): PipelineContext {
  const llm = oneToolThenStop();
  const mcpClient = {
    async listTools() {
      return {
        ok: true as const,
        value: [{ name: 'GetTable', description: 'read', inputSchema: {} }],
      };
    },
    callTool: client.callTool,
  };
  const options: CallOptions = {
    trace: { traceId: 'trace-timing-test' },
    sessionLogger: spySession,
  } as unknown as CallOptions;
  return {
    config: {
      maxIterations: 3,
      maxToolCalls: 5,
      heartbeatIntervalMs: 5000,
      mode: 'smart',
      refreshToolsPerIteration: false,
    },
    options,
    sessionId: 's-timing',
    mcpClients: [mcpClient],
    mainLlm: llm,
    inputText: '',
    history: [] as Message[],
    assembledMessages: [{ role: 'user', content: 'read table' } as Message],
    activeTools: [TOOL],
    externalTools: [] as LlmTool[],
    selectedTools: [TOOL],
    mcpTools: [],
    toolClientMap: new Map<string, typeof mcpClient>([['GetTable', mcpClient]]),
    toolCache: new NoopToolCache(),
    ragStores: {},
    timing: [],
    pendingToolResults: new PendingToolResultsRegistry(),
    toolAvailabilityRegistry: new ToolAvailabilityRegistry(),
    requestLogger: new NoopRequestLogger(),
    logger: spyLogger,
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
    yield(_chunk: Result<LlmStreamChunk, unknown>) {},
  } as unknown as PipelineContext;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('tool-loop emits tool_call structured event on successful tool call', async () => {
  const spy = new SpyLogger();
  const session = new SpySessionLogger();
  const ctx = makeCtx(
    {
      async callTool() {
        return { ok: true as const, value: { content: 'row data' } };
      },
    },
    spy,
    session,
  );

  await new ToolLoopHandler().execute(ctx, {}, makeSpan());

  const evt = spy.events.find((e) => e.type === 'tool_call');
  assert.ok(evt, 'a tool_call event must be emitted');
  assert.equal(evt.type, 'tool_call');
  assert.equal(evt.toolName, 'GetTable');
  assert.equal(evt.traceId, 'trace-timing-test');
  assert.equal(typeof evt.durationMs, 'number');
  assert.ok(evt.durationMs >= 0, 'durationMs must be non-negative');
  assert.equal(
    evt.isError,
    false,
    'isError must be false for a successful call',
  );
});

test('tool-loop emits mcp_tool_call session step on successful tool call', async () => {
  const spy = new SpyLogger();
  const session = new SpySessionLogger();
  const ctx = makeCtx(
    {
      async callTool() {
        return { ok: true as const, value: { content: 'row data' } };
      },
    },
    spy,
    session,
  );

  await new ToolLoopHandler().execute(ctx, {}, makeSpan());

  const step = session.steps.find((s) => s.name === 'mcp_tool_call');
  assert.ok(step, 'an mcp_tool_call session step must be emitted');
  const data = step.data as {
    toolName: string;
    durationMs: number;
    isError: boolean;
  };
  assert.equal(data.toolName, 'GetTable');
  assert.equal(typeof data.durationMs, 'number');
  assert.ok(data.durationMs >= 0, 'durationMs must be non-negative');
  assert.equal(data.isError, false);
});

test('tool-loop emits tool_call event with isError:true when tool call fails', async () => {
  const spy = new SpyLogger();
  const session = new SpySessionLogger();
  const ctx = makeCtx(
    {
      async callTool() {
        return {
          ok: false as const,
          error: new McpError('table not found', 'MCP_ERROR'),
        };
      },
    },
    spy,
    session,
  );

  await new ToolLoopHandler().execute(ctx, {}, makeSpan());

  const evt = spy.events.find((e) => e.type === 'tool_call');
  assert.ok(evt, 'a tool_call event must be emitted even on error');
  assert.equal(evt.type, 'tool_call');
  assert.equal(evt.toolName, 'GetTable');
  assert.equal(evt.isError, true, 'isError must be true for a failed call');
  assert.ok(evt.durationMs >= 0);
});

test('tool-loop emits mcp_tool_call session step with isError:true on failure', async () => {
  const spy = new SpyLogger();
  const session = new SpySessionLogger();
  const ctx = makeCtx(
    {
      async callTool() {
        return {
          ok: false as const,
          error: new McpError('table not found', 'MCP_ERROR'),
        };
      },
    },
    spy,
    session,
  );

  await new ToolLoopHandler().execute(ctx, {}, makeSpan());

  const step = session.steps.find((s) => s.name === 'mcp_tool_call');
  assert.ok(step, 'an mcp_tool_call session step must be emitted on error');
  const data = step.data as { isError: boolean };
  assert.equal(data.isError, true);
});
