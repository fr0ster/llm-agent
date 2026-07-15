/**
 * Task 8 — ToolLoopHandler forms per-round context via IToolLoopContextStrategy.
 *
 * Test 1 (flatness): With WindowContextStrategy(keepLastRounds=1), K tool
 * calls then a final content — the per-round messages length must not grow
 * with K once the window is full.
 *
 * Test 2 (reprompt survival): After runOutputValidationReprompt appends a
 * correction to controlTail, the correction must still appear in the messages
 * seen by the NEXT LLM call (i.e. it survives form()).
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
import { type McpError, NoopToolCache } from '@mcp-abap-adt/llm-agent';
import { WindowContextStrategy } from '../../../pipeline/context/tool-loop-context/index.js';
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

// ---------------------------------------------------------------------------
// Test 1: Flatness (WindowContextStrategy bounds growth)
// ---------------------------------------------------------------------------

/**
 * LLM that emits K GetTable tool calls (one per iteration), then a final
 * content 'done'. Each tool call iteration is a single-call batch.
 */
function makeKToolsThenStopLlm(k: number, capturedMessages: Message[][]): ILlm {
  let call = 0;
  async function* stream(
    msgs: Message[],
  ): AsyncIterable<Result<LlmStreamChunk, LlmError>> {
    capturedMessages.push([...msgs]);
    call++;
    if (call <= k) {
      yield {
        ok: true,
        value: {
          content: '',
          toolCalls: [{ id: `c${call}`, name: 'GetTable', arguments: {} }],
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

function makeFlatnessCtx(
  llm: ILlm,
  capturedMessages: Message[][],
): PipelineContext {
  const mcpClient = {
    async listTools() {
      return {
        ok: true as const,
        value: [{ name: 'GetTable', description: 'read', inputSchema: {} }],
      };
    },
    async callTool(): Promise<Result<McpToolResult, McpError>> {
      return { ok: true as const, value: { content: 'row data' } };
    },
  };
  const options: CallOptions = {} as unknown as CallOptions;
  return {
    config: {
      maxIterations: 10,
      maxToolCalls: 20,
      heartbeatIntervalMs: 5000,
      mode: 'smart',
      refreshToolsPerIteration: false,
    },
    options,
    sessionId: 's-flatness',
    mcpClients: [mcpClient],
    mainLlm: llm,
    inputText: 'read table',
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
    logger: new SpyLogger(),
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
        msgs: Message[],
        tools: LlmTool[],
        opts: CallOptions,
      ) => {
        return llm.streamChat?.(msgs, tools, opts);
      },
    } as unknown as PipelineContext['llmCallStrategy'],
    // Inject WindowContextStrategy with keepLastRounds=1 so context stays bounded
    toolLoopContextStrategyFactory: () =>
      new WindowContextStrategy({ keepLastRounds: 1 }),
    yield(_chunk: Result<LlmStreamChunk, unknown>) {},
  } as unknown as PipelineContext;
}

test('tool-loop context length does not grow with K when WindowContextStrategy is injected', async () => {
  const K = 4; // 4 tool-call rounds, then final content
  const capturedMessages: Message[][] = [];
  const llm = makeKToolsThenStopLlm(K, capturedMessages);
  const ctx = makeFlatnessCtx(llm, capturedMessages);

  await new ToolLoopHandler().execute(ctx, {}, makeSpan());

  // Should have captured K+1 LLM calls: K tool-call rounds + 1 final content
  assert.equal(capturedMessages.length, K + 1, `expected ${K + 1} LLM calls`);

  // After the window fills (keepLastRounds=1), lengths should stop growing.
  // Iteration 1: prefix.length + 0 rounds recorded yet = 1 msg (user)
  // Iteration 2: prefix.length + window(round1) = 1 + 2 = 3 (assistant+tool)
  // Iteration 3: prefix.length + marker(1 elided) + window(round2) = 1+1+2 = 4
  // Iteration 4: prefix.length + marker(2 elided) + window(round3) = 1+1+2 = 4
  // Iteration 5 (final): same = 4
  // Lengths for iterations 3+ should all be equal (window saturated)
  const lengths = capturedMessages.map((msgs) => msgs.length);
  assert.ok(
    lengths[2] === lengths[3] && lengths[3] === lengths[4],
    `expected lengths to stabilise after window fills but got ${lengths.join(',')}`,
  );
  assert.ok(
    lengths[K] < lengths[0] + K * 2,
    `context should not grow linearly with K; lengths: ${lengths.join(',')}`,
  );
});

// ---------------------------------------------------------------------------
// Test 2: Reprompt correction survives the next form()
// ---------------------------------------------------------------------------

/**
 * LLM that emits content (no tool calls) twice:
 *   call 1 → 'bad output'  (validator will reject)
 *   call 2 → 'good output' (validator will accept)
 */
function makeRepromptThenStopLlm(capturedMessages: Message[][]): ILlm {
  let call = 0;
  async function* stream(
    msgs: Message[],
  ): AsyncIterable<Result<LlmStreamChunk, LlmError>> {
    capturedMessages.push([...msgs]);
    call++;
    const content = call === 1 ? 'bad output' : 'good output';
    yield {
      ok: true,
      value: { content, finishReason: 'stop' },
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

function makeRepromptCtx(
  llm: ILlm,
  capturedMessages: Message[][],
): PipelineContext {
  const options: CallOptions = {} as unknown as CallOptions;
  let validateCall = 0;
  return {
    config: {
      maxIterations: 5,
      maxToolCalls: 10,
      heartbeatIntervalMs: 5000,
      mode: 'smart',
      refreshToolsPerIteration: false,
    },
    options,
    sessionId: 's-reprompt',
    mcpClients: [],
    mainLlm: llm,
    inputText: 'do something',
    history: [] as Message[],
    assembledMessages: [{ role: 'user', content: 'do something' } as Message],
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
    requestLogger: new NoopRequestLogger(),
    logger: new SpyLogger(),
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
      async validate(content: string) {
        validateCall++;
        if (validateCall === 1) {
          // First call: reject
          return {
            ok: true,
            value: {
              valid: false,
              reason: 'output was bad',
            },
          };
        }
        // Second call: accept
        return { ok: true, value: { valid: true } };
      },
    } as unknown as PipelineContext['outputValidator'],
    llmCallStrategy: {
      call: (
        _llm: ILlm,
        msgs: Message[],
        tools: LlmTool[],
        opts: CallOptions,
      ) => {
        return llm.streamChat?.(msgs, tools, opts);
      },
    } as unknown as PipelineContext['llmCallStrategy'],
    // No toolLoopContextStrategyFactory — defaults to LegacyAccumulateContextStrategy
    yield(_chunk: Result<LlmStreamChunk, unknown>) {},
  } as unknown as PipelineContext;
}

test('reprompt correction survives into next LLM call after form()', async () => {
  const capturedMessages: Message[][] = [];
  const llm = makeRepromptThenStopLlm(capturedMessages);
  const ctx = makeRepromptCtx(llm, capturedMessages);

  await new ToolLoopHandler().execute(ctx, {}, makeSpan());

  // Should have 2 LLM calls: one rejected, one accepted
  assert.equal(capturedMessages.length, 2, 'expected exactly 2 LLM calls');

  // The second LLM call must see the reprompt correction message
  const secondCallMessages = capturedMessages[1];
  const correctionMsg = secondCallMessages.find(
    (m) =>
      m.role === 'user' &&
      typeof m.content === 'string' &&
      m.content.includes('rejected by validation'),
  );
  assert.ok(
    correctionMsg !== undefined,
    `reprompt correction must be present in second LLM call messages; got: ${JSON.stringify(secondCallMessages.map((m) => ({ role: m.role, content: String(m.content).slice(0, 80) })))}`,
  );
});
