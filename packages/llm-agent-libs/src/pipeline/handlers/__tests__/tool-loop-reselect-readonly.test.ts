/**
 * Task 0 — PR-2b guard: Loop B characterization test.
 *
 * Pins the reselect READ-ONLY branch of ToolLoopHandler.execute:
 *
 *   B — on a read-only tool retry, Loop B RESTORES prevSelectedTools
 *       (the narrowed pre-refresh set) and does NOT log `tools_reselect_skipped`.
 *
 * Why this guards the right line:
 *   The restore is at tool-loop.ts:262 — `currentTools = prevSelectedTools`.
 *   The test is discriminating because:
 *     - prevSelectedTools = [SearchClass] (seed before refresh)
 *     - mcpClients.listTools returns [SearchClass, UpdateClass] (STRICTLY larger)
 *     - so without the restore, iteration 2 would receive [SearchClass, UpdateClass]
 *     - with the restore, iteration 2 must receive exactly [SearchClass]
 *   Deleting line 262 would cause iter2 to have 2 tools → assertion fails.
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
  McpTool,
  Message,
  RagError,
  RagQueryEntry,
  RagResult,
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
// Test helpers (mirroring tool-loop-external.test.ts structure)
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

// ---------------------------------------------------------------------------
// B characterization — reselect read-only restores prevSelectedTools
// ---------------------------------------------------------------------------

test('Loop B: read-only retry restores prevSelectedTools and emits no skip log', async () => {
  const captured: LlmTool[][] = [];
  const logSteps: string[] = [];
  let callIdx = 0;

  // MCP client: listTools returns BOTH SearchClass AND UpdateClass (refresh set
  // strictly larger than the seed — this size gap is what makes the guard
  // discriminate: without the restore at tool-loop.ts:262, iteration 2 would
  // see [SearchClass, UpdateClass] and the deepEqual assertion would fail).
  const mcpClient = {
    async listTools() {
      return {
        ok: true as const,
        value: [
          {
            name: 'SearchClass',
            description: 'search',
            inputSchema: { type: 'object' },
          },
          {
            name: 'UpdateClass',
            description: 'update',
            inputSchema: { type: 'object' },
          },
        ] as McpTool[],
      };
    },
    async callTool(
      _name: string,
      _args: string,
      _opts?: CallOptions,
    ): Promise<Result<{ content: string }, { message: string }>> {
      return { ok: true, value: { content: 'found results' } };
    },
  };

  // Seed tool (activeTools / toolClientMap): only SearchClass.
  // prevSelectedTools (snapshotted before refresh at iteration 1) = [searchTool].
  const searchTool: LlmTool = {
    name: 'SearchClass',
    description: 'search',
    inputSchema: { type: 'object' },
  };

  // Two streams: call 1 → SearchClass tool call; call 2 → stop.
  type Stream = () => AsyncIterable<Result<LlmStreamChunk, LlmError>>;
  const streams: Stream[] = [
    async function* () {
      yield {
        ok: true,
        value: {
          content: '',
          toolCalls: [
            { index: 0, id: 'tc_1', name: 'SearchClass', arguments: '{}' },
          ],
          finishReason: 'tool_calls',
        },
      } as Result<LlmStreamChunk, LlmError>;
    },
    async function* () {
      yield {
        ok: true,
        value: {
          content: 'done',
          finishReason: 'stop',
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        },
      } as Result<LlmStreamChunk, LlmError>;
    },
  ];

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

  const ctx = {
    config: {
      maxIterations: 5,
      maxToolCalls: 5,
      heartbeatIntervalMs: 5000,
      mode: 'smart',
      // refreshToolsPerIteration: true is the default (undefined !== false)
      toolReselectPerIteration: true,
    } as PipelineContext['config'],
    options: {
      sessionLogger: {
        logStep(step: string, _data: unknown) {
          logSteps.push(step);
        },
      },
    } as unknown as CallOptions,
    sessionId: 'b-reselect',
    mcpClients: [mcpClient],
    mainLlm: stubLlm,
    inputText: 'search classes',
    history: [] as Message[],
    assembledMessages: [
      { role: 'system' as const, content: 'sys' },
      { role: 'user' as const, content: 'search classes' },
    ] as Message[],
    // activeTools / toolClientMap seeded with ONLY SearchClass.
    // prevSelectedTools (line 187) will snapshot [searchTool] before refresh.
    activeTools: [searchTool] as LlmTool[],
    externalTools: [] as LlmTool[],
    externalResults: undefined,
    selectedTools: [] as LlmTool[],
    // mcpTools starts empty; refresh (iteration 1) populates it from mcpClient.
    mcpTools: [] as McpTool[],
    toolClientMap: new Map<string, typeof mcpClient>([
      ['SearchClass', mcpClient],
    ]),
    toolCache: new NoopToolCache(),
    // ragStores.tools MUST be present — tool-loop.ts:221 gates the reselect block
    // (and therefore line 262 read-only restore) on `ctx.ragStores?.tools` being
    // truthy.  Without it, the guarded branch never runs and the guard is inert.
    ragStores: {
      tools: {
        async query(): Promise<Result<RagResult[], RagError>> {
          return { ok: true, value: [] };
        },
        async healthCheck(): Promise<Result<void, RagError>> {
          return { ok: true, value: undefined };
        },
        async getById(): Promise<Result<RagResult | null, RagError>> {
          return { ok: true, value: null };
        },
        writer() {
          return {
            async upsertRaw(): Promise<Result<void, RagError>> {
              return { ok: true, value: undefined };
            },
            async deleteByIdRaw(): Promise<Result<boolean, RagError>> {
              return { ok: true, value: false };
            },
          };
        },
      },
    },
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
    // llmCallStrategy captures tools per call and dispatches streams.
    llmCallStrategy: {
      call(
        _llm: ILlm,
        _msgs: Message[],
        tools: LlmTool[],
        _opts?: CallOptions,
      ): AsyncIterable<Result<LlmStreamChunk, LlmError>> {
        captured.push([...tools]);
        const fn = streams[callIdx] ?? streams[streams.length - 1];
        callIdx += 1;
        return fn();
      },
    } as unknown as PipelineContext['llmCallStrategy'],
    yield(_chunk: Result<LlmStreamChunk, unknown>) {},
  } as unknown as PipelineContext;

  const ok = await new ToolLoopHandler().execute(ctx, {}, makeSpan());
  assert.equal(ok, true, 'execute must return true (clean stop)');

  // B does NOT log tools_reselect_skipped — that is Loop A's behavior.
  assert.ok(
    !logSteps.includes('tools_reselect_skipped'),
    'B does NOT log tools_reselect_skipped',
  );

  // Iteration 2 must have been offered EXACTLY [SearchClass] — the restored
  // prevSelectedTools.  If the restore at tool-loop.ts:262 were deleted,
  // currentTools would remain the refreshed [SearchClass, UpdateClass] and
  // this assertion would fail.
  const iter2 = captured[1] ?? [];
  assert.deepEqual(
    iter2.map((t) => t.name),
    ['SearchClass'],
    'B restores prevSelectedTools (narrowed subset) on read-only retry',
  );
});
