/**
 * Task 7 (#244) — both runtime tool-refresh paths namespace colliding MCP
 * tools using `ctx.mcpClientDescriptors`, paired with `ctx.mcpClients` from
 * ONE `connectionStrategy.resolve()` snapshot.
 *
 * Before this task, both `ToolSelectHandler` (first-load) and
 * `ToolLoopHandler` (per-iteration refresh) deduped `listTools()` results by
 * bare tool name: `if (!ctx.toolClientMap.has(t.name)) { push; set }`. When
 * two MCP clients each exposed a tool with the same name (e.g. `Search`),
 * the second one was silently DROPPED instead of namespaced.
 *
 * This test proves:
 *  1. Two clients both exposing `Search`, with descriptors
 *     `[{slotIndex:0},{slotIndex:1}]`, yield BOTH `s0__Search` and
 *     `s1__Search` in `ctx.mcpTools` / `ctx.toolClientMap` (not one dropped
 *     `Search`) — for both the tool-select first-load and the tool-loop
 *     refresh path.
 *  2. A dropped-slot descriptor set `[{slotIndex:0},{slotIndex:2}]` yields
 *     `s0__Search`/`s2__Search` prefixes (not `s0`/`s1`) — the descriptor's
 *     `slotIndex`, not the array position, drives the prefix.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  CallOptions,
  ILlm,
  IMcpClient,
  IRequestLogger,
  LlmError,
  LlmResponse,
  LlmStreamChunk,
  LlmTool,
  McpTool,
  Message,
  RequestSummary,
  Result,
} from '@mcp-abap-adt/llm-agent';
import { NoopToolCache } from '@mcp-abap-adt/llm-agent';
import type { McpClientDescriptor } from '../../../interfaces/mcp-connection-strategy.js';
import { PendingToolResultsRegistry } from '../../../policy/pending-tool-results-registry.js';
import { ToolAvailabilityRegistry } from '../../../policy/tool-availability-registry.js';
import type { ISpan } from '../../../tracer/types.js';
import type { PipelineContext } from '../../context.js';
import { ToolLoopHandler } from '../tool-loop.js';
import { ToolSelectHandler } from '../tool-select.js';

function makeSpan(): ISpan {
  return {
    name: 's',
    setAttribute() {},
    setStatus() {},
    addEvent() {},
    end() {},
  } as unknown as ISpan;
}

function makeSearchClient(): IMcpClient {
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

function noopRequestLogger(): IRequestLogger {
  return {
    logLlmCall() {},
    logRagQuery() {},
    logToolCall() {},
    startRequest() {},
    endRequest() {},
    dropRequest() {},
    getSummary(): RequestSummary {
      return {
        byModel: {},
        byComponent: {},
        byCategory: {},
        ragQueries: 0,
        toolCalls: 0,
        totalDurationMs: 0,
      };
    },
    reset() {},
  };
}

// ---------------------------------------------------------------------------
// tool-select — first-load
// ---------------------------------------------------------------------------

function makeSelectCtx(descriptors: McpClientDescriptor[]) {
  return {
    config: { mode: 'smart' },
    mcpTools: [] as McpTool[],
    mcpClients: [makeSearchClient(), makeSearchClient()],
    mcpClientDescriptors: descriptors,
    toolClientMap: new Map<string, IMcpClient>(),
    ragResults: {},
    ragStores: {},
    externalTools: [] as LlmTool[],
    embedder: undefined,
    toolSelectionStrategy: undefined,
    sessionId: 's1',
    options: {},
    toolAvailabilityRegistry: {
      filterTools: (_s: string, tools: unknown[]) => ({
        allowed: tools,
        blocked: [],
      }),
    },
    selectedTools: [] as unknown[],
    activeTools: [] as unknown[],
  };
}

const span = { setAttribute() {} };

test('tool-select first-load namespaces two colliding Search tools instead of dropping the second', async () => {
  const ctx = makeSelectCtx([{ slotIndex: 0 }, { slotIndex: 1 }]);
  // biome-ignore lint/suspicious/noExplicitAny: minimal ctx stub for handler test
  await new ToolSelectHandler().execute(ctx as any, {}, span as any);

  assert.deepEqual(
    ctx.mcpTools.map((t) => t.name).sort(),
    ['s0__Search', 's1__Search'],
    'both colliding Search tools must be namespaced and kept, not deduped away',
  );
  assert.deepEqual(
    [...ctx.toolClientMap.keys()].sort(),
    ['s0__Search', 's1__Search'],
    'toolClientMap must carry an entry for each namespaced tool',
  );
});

test('tool-select first-load uses descriptor slotIndex (not array position) as the prefix on a dropped slot', async () => {
  const ctx = makeSelectCtx([{ slotIndex: 0 }, { slotIndex: 2 }]);
  // biome-ignore lint/suspicious/noExplicitAny: minimal ctx stub for handler test
  await new ToolSelectHandler().execute(ctx as any, {}, span as any);

  assert.deepEqual(
    ctx.mcpTools.map((t) => t.name).sort(),
    ['s0__Search', 's2__Search'],
    'prefixes must follow descriptor slotIndex (0, 2), not settled-array index (0, 1)',
  );
});

// ---------------------------------------------------------------------------
// tool-loop — per-iteration refresh
// ---------------------------------------------------------------------------

/**
 * Drives ToolLoopHandler through exactly two iterations:
 *   iteration 0 — LLM calls the seeded (bare) `Search` tool.
 *   iteration 1 — refresh runs FIRST (iteration > 0), re-listing both
 *                  mcpClients (both now returning `Search`) and namespacing
 *                  the collision; then the LLM stream stops.
 * After execute() resolves, ctx.mcpTools / ctx.toolClientMap hold the
 * refreshed (namespaced) state.
 */
function makeLoopCtx(descriptors: McpClientDescriptor[]) {
  const client0 = makeSearchClient();
  const client1 = makeSearchClient();

  const streams: Array<() => AsyncIterable<Result<LlmStreamChunk, LlmError>>> =
    [
      async function* () {
        yield {
          ok: true,
          value: {
            content: '',
            toolCalls: [
              { index: 0, id: 'tc_1', name: 'Search', arguments: '{}' },
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

  const stubLlm: ILlm = {
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
  };

  const searchTool: LlmTool = {
    name: 'Search',
    description: 'search',
    inputSchema: {},
  } as unknown as LlmTool;

  const ctx = {
    config: {
      maxIterations: 5,
      maxToolCalls: 5,
      heartbeatIntervalMs: 5000,
      mode: 'smart',
      // refreshToolsPerIteration defaults on (undefined !== false)
    } as PipelineContext['config'],
    options: {} as CallOptions,
    sessionId: 'loop-namespace',
    mcpClients: [client0, client1],
    mcpClientDescriptors: descriptors,
    mainLlm: stubLlm,
    inputText: 'search',
    history: [] as Message[],
    assembledMessages: [
      { role: 'user' as const, content: 'search' },
    ] as Message[],
    // Seeded (pre-refresh) state: only the bare Search tool, bound to client0.
    activeTools: [searchTool],
    externalTools: [] as LlmTool[],
    selectedTools: [] as LlmTool[],
    mcpTools: [] as McpTool[],
    toolClientMap: new Map<string, IMcpClient>([['Search', client0]]),
    toolCache: new NoopToolCache(),
    ragStores: {},
    timing: [],
    pendingToolResults: new PendingToolResultsRegistry(),
    toolAvailabilityRegistry: new ToolAvailabilityRegistry(),
    requestLogger: noopRequestLogger(),
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

  return { ctx, client0, client1 };
}

test('tool-loop refresh namespaces two colliding Search tools instead of dropping the second', async () => {
  const { ctx } = makeLoopCtx([{ slotIndex: 0 }, { slotIndex: 1 }]);
  const ok = await new ToolLoopHandler().execute(ctx, {}, makeSpan());
  assert.equal(ok, true, 'execute must complete cleanly');

  assert.deepEqual(
    ctx.mcpTools.map((t) => t.name).sort(),
    ['s0__Search', 's1__Search'],
    'refresh must namespace both colliding Search tools, not drop the second',
  );
  assert.deepEqual(
    [...ctx.toolClientMap.keys()].sort(),
    ['s0__Search', 's1__Search'],
    'refreshed toolClientMap must carry an entry for each namespaced tool',
  );
});

test('tool-loop refresh uses descriptor slotIndex (not array position) as the prefix on a dropped slot', async () => {
  const { ctx } = makeLoopCtx([{ slotIndex: 0 }, { slotIndex: 2 }]);
  const ok = await new ToolLoopHandler().execute(ctx, {}, makeSpan());
  assert.equal(ok, true, 'execute must complete cleanly');

  assert.deepEqual(
    ctx.mcpTools.map((t) => t.name).sort(),
    ['s0__Search', 's2__Search'],
    'prefixes must follow descriptor slotIndex (0, 2), not settled-array index (0, 1)',
  );
});
