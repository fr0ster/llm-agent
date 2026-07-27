/**
 * Task 4 (#171) — tool-loop surfaces external (client-provided) tool calls.
 *
 * Verifies:
 *  1. `mode: 'hard'` still OFFERS external tools to the LLM (no drop).
 *  2. Miss (no externalResults entry): the worker turn ENDS with
 *     finishReason 'tool_calls', yielding the external call with its id
 *     rewritten to externalToolCallId(name, args); the tool is NOT executed.
 *  3. Hit (externalResults has extId): the worker conversation gets a matched
 *     assistant(tool_calls=[extId]) -> tool(tool_call_id=extId) pair and the
 *     loop CONTINUES; NO client-facing toolCalls chunk is yielded for the call.
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
  McpTool,
  Message,
  OnPartial,
  RagQueryEntry,
  RequestSummary,
  Result,
  ToolCallEntry,
} from '@mcp-abap-adt/llm-agent';
import { externalToolCallId, NoopToolCache } from '@mcp-abap-adt/llm-agent';
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

interface CapturedCall {
  messages: Message[];
  tools: LlmTool[];
}

const RAG_ADD: LlmTool = {
  name: 'rag_add',
  description: '[client-provided] add to rag',
  parameters: { type: 'object', properties: {} },
} as unknown as LlmTool;

/**
 * Builds a ctx whose llmCallStrategy returns the i-th programmed stream on the
 * i-th call, capturing the (messages, tools) of each call.
 */
function makeCtx(opts: {
  mode?: 'smart' | 'hard';
  externalTools?: LlmTool[];
  externalResults?: Map<string, string>;
  streams: Array<() => AsyncIterable<Result<LlmStreamChunk, LlmError>>>;
  onPartial?: OnPartial;
}): {
  ctx: PipelineContext;
  captured: CapturedCall[];
  yielded: Result<LlmStreamChunk, unknown>[];
} {
  const captured: CapturedCall[] = [];
  const yielded: Result<LlmStreamChunk, unknown>[] = [];
  let callIdx = 0;

  const mainLlm: ILlm = {
    model: 'stub-model',
    async chat(): Promise<Result<LlmResponse, LlmError>> {
      return {
        ok: true,
        value: { content: '', finishReason: 'stop' } as LlmResponse,
      };
    },
    streamChat: () => opts.streams[0](),
  };

  const ctx = {
    config: {
      maxIterations: 5,
      maxToolCalls: 5,
      heartbeatIntervalMs: 5000,
      mode: opts.mode ?? 'smart',
      refreshToolsPerIteration: false,
    } as PipelineContext['config'],
    options: {} as CallOptions,
    sessionId: 's-ext',
    mcpClients: [],
    mainLlm,
    inputText: '',
    history: [] as Message[],
    assembledMessages: [
      { role: 'system', content: 'sys' } as Message,
      { role: 'user', content: 'hi' } as Message,
    ],
    activeTools: (opts.externalTools ?? []) as LlmTool[],
    externalTools: (opts.externalTools ?? []) as LlmTool[],
    externalResults: opts.externalResults,
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
        msgs: Message[],
        tools: LlmTool[],
        _o?: CallOptions,
      ) => {
        captured.push({ messages: msgs, tools });
        const fn =
          opts.streams[callIdx] ?? opts.streams[opts.streams.length - 1];
        callIdx += 1;
        return fn();
      },
    } as unknown as PipelineContext['llmCallStrategy'],
    onPartial: opts.onPartial,
    yield(chunk: Result<LlmStreamChunk, unknown>) {
      yielded.push(chunk);
    },
  } as unknown as PipelineContext;

  return { ctx, captured, yielded };
}

/** A stream that emits a single external tool_call delta then finishes. */
function externalCallStream(
  name: string,
  args: Record<string, unknown>,
  rawId = 'call_raw',
): () => AsyncIterable<Result<LlmStreamChunk, LlmError>> {
  return async function* () {
    yield {
      ok: true,
      value: {
        content: '',
        toolCalls: [
          { index: 0, id: rawId, name, arguments: JSON.stringify(args) },
        ],
      },
    } as Result<LlmStreamChunk, LlmError>;
    yield {
      ok: true,
      value: {
        content: '',
        finishReason: 'tool_calls',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      },
    } as Result<LlmStreamChunk, LlmError>;
  };
}

/** A plain stream that finishes with stop. */
function stopStream(
  content = 'done',
): () => AsyncIterable<Result<LlmStreamChunk, LlmError>> {
  return async function* () {
    yield {
      ok: true,
      value: {
        content,
        finishReason: 'stop',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      },
    } as Result<LlmStreamChunk, LlmError>;
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('hard mode still offers external tools to the LLM', async () => {
  const args = { content: 'x' };
  const { ctx, captured } = makeCtx({
    mode: 'hard',
    externalTools: [RAG_ADD],
    streams: [externalCallStream('rag_add', args)],
  });

  await new ToolLoopHandler().execute(ctx, {}, makeSpan());

  assert.ok(captured.length >= 1, 'at least one LLM call');
  const toolNames = captured[0].tools.map((t) => t.name);
  assert.ok(
    toolNames.includes('rag_add'),
    `hard mode must offer external tools, got: ${toolNames.join(',')}`,
  );
});

test('miss: external call ends the turn with rewritten extId, not executed', async () => {
  const args = { content: 'hello' };
  const extId = externalToolCallId('rag_add', args);
  let toolExecuted = false;

  const { ctx, yielded } = makeCtx({
    mode: 'smart',
    externalTools: [RAG_ADD],
    streams: [externalCallStream('rag_add', args)],
  });
  // Spy: if a client were registered we'd see execution. rag_add is NOT in
  // toolClientMap, so it can never be executed; assert no tool result chunk.
  ctx.toolCache = {
    get() {
      toolExecuted = true;
      return undefined;
    },
    set() {},
  } as unknown as PipelineContext['toolCache'];

  const ok = await new ToolLoopHandler().execute(ctx, {}, makeSpan());
  assert.equal(ok, true);
  assert.equal(toolExecuted, false, 'external tool must not be executed');

  // Find the toolCalls chunk and the terminal chunk.
  const callChunks = yielded.filter(
    (c) => c.ok && Array.isArray((c.value as LlmStreamChunk).toolCalls),
  ) as Array<Result<LlmStreamChunk, unknown>>;
  assert.ok(callChunks.length >= 1, 'an external toolCalls chunk was yielded');
  const calls = (callChunks[0].value as LlmStreamChunk).toolCalls ?? [];
  const ids = calls.map((c) =>
    'id' in c ? (c as { id?: string }).id : undefined,
  );
  assert.ok(
    ids.includes(extId),
    `surfaced call carries extId ${extId}, got ${JSON.stringify(ids)}`,
  );

  const terminal = yielded.find(
    (c) => c.ok && (c.value as LlmStreamChunk).finishReason === 'tool_calls',
  );
  assert.ok(terminal, 'terminal finishReason tool_calls chunk yielded');
});

test('regression #171: two external-miss calls get distinct indices [0,1], not [0,0]', async () => {
  const args0 = { a: 1 };
  const args1 = { b: 2 };
  const extId0 = externalToolCallId('rag_add', args0);
  const extId1 = externalToolCallId('rag_add', args1);

  // Stream emits both calls in a single delta chunk then finishes with tool_calls.
  const twoExternalStream: () => AsyncIterable<
    Result<LlmStreamChunk, LlmError>
  > = async function* () {
    yield {
      ok: true,
      value: {
        content: '',
        toolCalls: [
          {
            index: 0,
            id: 'raw_0',
            name: 'rag_add',
            arguments: JSON.stringify(args0),
          },
          {
            index: 1,
            id: 'raw_1',
            name: 'rag_add',
            arguments: JSON.stringify(args1),
          },
        ],
      },
    } as Result<LlmStreamChunk, LlmError>;
    yield {
      ok: true,
      value: {
        content: '',
        finishReason: 'tool_calls',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      },
    } as Result<LlmStreamChunk, LlmError>;
  };

  const { ctx, yielded } = makeCtx({
    mode: 'smart',
    externalTools: [RAG_ADD],
    streams: [twoExternalStream],
  });

  const ok = await new ToolLoopHandler().execute(ctx, {}, makeSpan());
  assert.equal(ok, true);

  // Find the toolCalls chunk surfaced by the miss path.
  const callChunks = yielded.filter(
    (c) => c.ok && Array.isArray((c.value as LlmStreamChunk).toolCalls),
  ) as Array<Result<LlmStreamChunk, unknown>>;
  assert.ok(callChunks.length >= 1, 'an external toolCalls chunk was yielded');

  const calls = (callChunks[0].value as LlmStreamChunk).toolCalls ?? [];
  assert.equal(calls.length, 2, 'both external calls must be surfaced');

  // Regression: with the old bug both entries had index 0 (all-0). Now they
  // must be mapped by array position.
  const indices = calls.map((c) => (c as { index: number }).index);
  assert.deepEqual(
    indices,
    [0, 1],
    `expected distinct indices [0,1], got ${JSON.stringify(indices)}`,
  );

  const ids = calls.map((c) => (c as { id?: string }).id);
  assert.ok(
    ids.includes(extId0),
    `first call must carry extId for args0 (${extId0})`,
  );
  assert.ok(
    ids.includes(extId1),
    `second call must carry extId for args1 (${extId1})`,
  );

  const terminal = yielded.find(
    (c) => c.ok && (c.value as LlmStreamChunk).finishReason === 'tool_calls',
  );
  assert.ok(terminal, 'terminal finishReason tool_calls chunk yielded');
});

test('hit: matched pair injected, loop continues, no external chunk leaked', async () => {
  const args = { content: 'hello' };
  const extId = externalToolCallId('rag_add', args);

  const { ctx, captured, yielded } = makeCtx({
    mode: 'smart',
    externalTools: [RAG_ADD],
    externalResults: new Map([[extId, 'RESULT']]),
    streams: [externalCallStream('rag_add', args), stopStream('final')],
  });

  const ok = await new ToolLoopHandler().execute(ctx, {}, makeSpan());
  assert.equal(ok, true);

  // (a) The SECOND LLM call's messages contain the adjacent matched pair.
  assert.ok(captured.length >= 2, 'loop continued to a second LLM call');
  const msgs = captured[1].messages;
  let foundPair = false;
  for (let i = 0; i < msgs.length - 1; i++) {
    const a = msgs[i] as Message & {
      tool_calls?: Array<{ id: string }>;
    };
    const t = msgs[i + 1] as Message & { tool_call_id?: string };
    if (
      a.role === 'assistant' &&
      Array.isArray(a.tool_calls) &&
      a.tool_calls.some((tc) => tc.id === extId) &&
      t.role === 'tool' &&
      t.tool_call_id === extId
    ) {
      foundPair = true;
      assert.equal(t.content, 'RESULT', 'tool message carries the result');
    }
  }
  assert.ok(
    foundPair,
    'adjacent assistant(tool_calls=[extId]) -> tool(tool_call_id=extId) pair present',
  );

  // (b) NO client-facing external toolCalls chunk was yielded for the resumed call.
  const leaked = yielded.filter((c) => {
    if (!c.ok) return false;
    const v = c.value as LlmStreamChunk;
    return (
      Array.isArray(v.toolCalls) &&
      v.toolCalls.some(
        (tc) => 'id' in tc && (tc as { id?: string }).id === extId,
      )
    );
  });
  assert.equal(leaked.length, 0, 'resumed external call must NOT be surfaced');
});

// ---------------------------------------------------------------------------
// Task 9 (#244) — mergeOfferedTools fail-fast at the tool-loop refresh merge.
//
// The per-iteration "refresh MCP tools" path (`ToolLoopHandler`, iteration > 0)
// re-lists every mcpClient and merges the (possibly namespaced) internal tools
// with `ctx.externalTools`. Before Task 9 this was a bare
// `[...internal, ...external]` concat: a client-provided external tool sharing
// a name with an internal (exposed) tool silently produced a duplicate-named
// entry in the offered tools array, which lets `classifyToolCalls` treat a
// call to that name as BOTH internal and external non-deterministically.
// `mergeOfferedTools` must fail fast instead.
//
// Both cases drive the loop through exactly two iterations: iteration 0 calls
// a pre-seeded bare `Search` tool (executed via a pre-populated
// `toolClientMap`, so no refresh is needed yet); iteration 1 is `iteration >
// 0`, so the refresh block runs FIRST — re-listing `ctx.mcpClients` and
// merging the result with `ctx.externalTools` — before any second LLM call
// happens.
// ---------------------------------------------------------------------------

function makeSearchMcpClient(): IMcpClient {
  return {
    async listTools() {
      return {
        ok: true as const,
        value: [
          { name: 'Search', description: 'search', inputSchema: {} },
        ] as McpTool[],
      };
    },
    async callTool() {
      return { ok: true, value: { content: 'found' } };
    },
  } as IMcpClient;
}

/**
 * Drives `ToolLoopHandler` through exactly two iterations, seeding
 * `ctx.mcpClients` with `clientCount` clients that all expose a bare `Search`
 * tool (so `clientCount >= 2` produces the namespaced `s0__Search` /
 * `s1__Search` pair per `buildNamespacedTools`'s collision rule, while
 * `clientCount === 1` keeps the bare `Search` name), and offering
 * `externalTools` alongside them.
 *
 * Iteration 0 calls a DIFFERENT pre-seeded internal tool (`Other`, unrelated
 * to `externalTools`) purely to advance the loop to iteration 1 without
 * itself hitting the classification the refresh merge is meant to guard —
 * the refresh at iteration 1 is what produces the (possibly namespaced)
 * `Search` name(s) that collide with `externalTools`.
 */
function makeRefreshCollisionCtx(
  clientCount: number,
  externalTools: LlmTool[],
): PipelineContext {
  const clients = Array.from({ length: clientCount }, () =>
    makeSearchMcpClient(),
  );

  const streams: Array<() => AsyncIterable<Result<LlmStreamChunk, LlmError>>> =
    [
      async function* () {
        yield {
          ok: true,
          value: {
            content: '',
            toolCalls: [
              { index: 0, id: 'tc_1', name: 'Other', arguments: '{}' },
            ],
            finishReason: 'tool_calls',
          },
        } as Result<LlmStreamChunk, LlmError>;
      },
      async function* () {
        yield {
          ok: true,
          value: { content: 'done', finishReason: 'stop' },
        } as Result<LlmStreamChunk, LlmError>;
      },
    ];
  let callIdx = 0;

  const otherTool: LlmTool = {
    name: 'Other',
    description: 'other',
    inputSchema: {},
  } as unknown as LlmTool;

  return {
    config: {
      maxIterations: 5,
      maxToolCalls: 5,
      heartbeatIntervalMs: 5000,
      mode: 'smart',
      // refreshToolsPerIteration defaults on (undefined !== false)
    } as PipelineContext['config'],
    options: {} as CallOptions,
    sessionId: 'loop-namespace-collision',
    mcpClients: clients,
    mainLlm: {
      model: 'stub',
      async chat(): Promise<Result<LlmResponse, LlmError>> {
        return { ok: true, value: { content: '', finishReason: 'stop' } };
      },
      async *streamChat(): AsyncIterable<Result<LlmStreamChunk, LlmError>> {
        yield {
          ok: true,
          value: { content: 'stub', finishReason: 'stop' },
        } as Result<LlmStreamChunk, LlmError>;
      },
    } as ILlm,
    inputText: 'search',
    history: [] as Message[],
    assembledMessages: [
      { role: 'user' as const, content: 'search' },
    ] as Message[],
    // Seeded (pre-refresh) state: only the unrelated `Other` tool, bound to
    // client 0 — kept disjoint from `externalTools` on purpose (see doc above).
    activeTools: [otherTool],
    externalTools,
    selectedTools: [] as LlmTool[],
    mcpTools: [] as McpTool[],
    toolClientMap: new Map<string, IMcpClient>([['Other', clients[0]]]),
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
        return { ok: true as const, value: { valid: true } };
      },
    } as unknown as PipelineContext['outputValidator'],
    llmCallStrategy: {
      call(): AsyncIterable<Result<LlmStreamChunk, LlmError>> {
        const fn = streams[callIdx] ?? streams[streams.length - 1];
        callIdx += 1;
        return fn();
      },
    } as unknown as PipelineContext['llmCallStrategy'],
    yield() {},
  } as unknown as PipelineContext;
}

test('collision: external tool named the same as a bare internal tool throws the mergeOfferedTools diagnostic', async () => {
  // A single mcpClient exposing `Search` → buildNamespacedTools keeps the bare
  // name (no collision across clients). The external tool is ALSO named
  // `Search` — an internal/external name collision at the refresh merge.
  const ctx = makeRefreshCollisionCtx(1, [
    {
      name: 'Search',
      description: '[client-provided] external search',
      inputSchema: { type: 'object', properties: {} },
    } as unknown as LlmTool,
  ]);

  await assert.rejects(
    () => new ToolLoopHandler().execute(ctx, {}, makeSpan()),
    /tool "Search" is both an internal MCP tool.*and a client-provided external tool/,
  );
});

test('collision: external tool named the same as a generated s0__Search throws the mergeOfferedTools diagnostic', async () => {
  // TWO mcpClients both exposing `Search` → buildNamespacedTools namespaces the
  // collision into `s0__Search` / `s1__Search`. The external tool is named
  // exactly `s0__Search` — colliding with the GENERATED internal name.
  const ctx = makeRefreshCollisionCtx(2, [
    {
      name: 's0__Search',
      description: '[client-provided] external search',
      inputSchema: { type: 'object', properties: {} },
    } as unknown as LlmTool,
  ]);

  await assert.rejects(
    () => new ToolLoopHandler().execute(ctx, {}, makeSpan()),
    /tool "s0__Search" is both an internal MCP tool.*and a client-provided external tool/,
  );
});
