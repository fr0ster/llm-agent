/**
 * Phase 3 / Task 5 — the pipeline-handler tool loop fails loud on an MCP
 * availability error (yields ok:false, execute() returns false) instead of
 * feeding "MCP error" back to the LLM as tool text. A tool-level error stays
 * feedback (the loop continues).
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
  McpToolResult,
  Message,
  Result,
} from '@mcp-abap-adt/llm-agent';
import { McpError, NoopToolCache } from '@mcp-abap-adt/llm-agent';
import { PendingToolResultsRegistry } from '../../../policy/pending-tool-results-registry.js';
import { ToolAvailabilityRegistry } from '../../../policy/tool-availability-registry.js';
import type { ISpan } from '../../../tracer/types.js';
import type { PipelineContext } from '../../context.js';
import { ToolLoopHandler } from '../tool-loop.js';

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
  function: { name: 'GetTable', description: 'read', parameters: {} },
} as unknown as LlmTool;

/** LLM that streams one GetTable tool call, then final text if reached. */
function toolThenText(): ILlm {
  let n = 0;
  async function* stream(): AsyncIterable<Result<LlmStreamChunk, LlmError>> {
    if (++n === 1) {
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

function makeCtx(client: IMcpClient): {
  ctx: PipelineContext;
  yielded: Result<LlmStreamChunk, unknown>[];
} {
  const yielded: Result<LlmStreamChunk, unknown>[] = [];
  const llm = toolThenText();
  const ctx = {
    config: {
      maxIterations: 3,
      maxToolCalls: 5,
      heartbeatIntervalMs: 5000,
      mode: 'smart',
      refreshToolsPerIteration: false,
    },
    options: {} as CallOptions,
    sessionId: 's-unavail',
    mcpClients: [client],
    mainLlm: llm,
    inputText: '',
    history: [] as Message[],
    assembledMessages: [{ role: 'user', content: 'read table' } as Message],
    activeTools: [TOOL],
    externalTools: [] as LlmTool[],
    selectedTools: [TOOL],
    mcpTools: [],
    toolClientMap: new Map<string, IMcpClient>([['GetTable', client]]),
    toolCache: new NoopToolCache(),
    ragStores: {},
    timing: [],
    pendingToolResults: new PendingToolResultsRegistry(),
    toolAvailabilityRegistry: new ToolAvailabilityRegistry(),
    requestLogger: {
      logLlmCall() {},
      logRagQuery() {},
      logToolCall() {},
      startRequest() {},
      endRequest() {},
      dropRequest() {},
      getSummary() {
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
    } as IRequestLogger,
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
    yield(chunk: Result<LlmStreamChunk, unknown>) {
      yielded.push(chunk);
    },
  } as unknown as PipelineContext;
  return { ctx, yielded };
}

function clientReturning(res: Result<McpToolResult, McpError>): IMcpClient {
  return {
    async listTools() {
      return {
        ok: true as const,
        value: [{ name: 'GetTable', description: 'read', inputSchema: {} }],
      };
    },
    async callTool() {
      return res;
    },
  } as IMcpClient;
}

test('tool-loop handler fails loud on an MCP availability error', async () => {
  const { ctx, yielded } = makeCtx(
    clientReturning({
      ok: false,
      error: new McpError('Not connected', 'MCP_NOT_CONNECTED'),
    }),
  );
  const ok = await new ToolLoopHandler().execute(ctx, {}, makeSpan());
  assert.equal(ok, false, 'execute() must report failure');
  assert.ok(
    yielded.some((c) => !c.ok),
    'an error chunk must be yielded',
  );
});

test('tool-loop handler keeps a tool-level error as feedback (no fail-loud)', async () => {
  const { ctx, yielded } = makeCtx(
    clientReturning({
      ok: false,
      error: new McpError('table not found', 'MCP_ERROR'),
    }),
  );
  const ok = await new ToolLoopHandler().execute(ctx, {}, makeSpan());
  // A tool-level error is fed back to the LLM; the loop proceeds to completion.
  assert.equal(ok, true, 'tool-level error must not fail the loop');
  assert.ok(
    !yielded.some((c) => !c.ok),
    'no error chunk for a tool-level error',
  );
});
