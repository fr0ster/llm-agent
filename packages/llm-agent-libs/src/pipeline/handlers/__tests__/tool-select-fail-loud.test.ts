/**
 * Spec §10.5.3 M5–M8 — tool selection fails loud: a client that cannot list
 * its tools is MCP_UNAVAILABLE (never a request run on fewer tools), a failed
 * discovery / re-select store query fails with the store's code (never the
 * previous set or zero tools). A successful query with no hits stays an honest
 * empty answer.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  CallOptions,
  ILlm,
  IMcpClient,
  IRag,
  IRequestLogger,
  LlmError,
  LlmResponse,
  LlmStreamChunk,
  LlmTool,
  McpTool,
  Message,
  RagResult,
  RequestSummary,
  Result,
} from '@mcp-abap-adt/llm-agent';
import {
  McpError,
  NoopToolCache,
  OrchestratorError,
  RagError,
} from '@mcp-abap-adt/llm-agent';
import { SmartAgent } from '../../../agent.js';
import { PendingToolResultsRegistry } from '../../../policy/pending-tool-results-registry.js';
import { ToolAvailabilityRegistry } from '../../../policy/tool-availability-registry.js';
import { makeDefaultDeps, makeMcpClient } from '../../../testing/index.js';
import type { ISpan } from '../../../tracer/types.js';
import type { PipelineContext } from '../../context.js';
import { DefaultPipeline } from '../../default-pipeline.js';
import { ToolLoopHandler } from '../tool-loop.js';
import { ToolSelectHandler } from '../tool-select.js';

const SEARCH: McpTool = { name: 'SearchA', description: 'a', inputSchema: {} };
const UPDATE: McpTool = { name: 'UpdateB', description: 'b', inputSchema: {} };

function makeSpan(): ISpan {
  return {
    name: 's',
    setAttribute() {},
    setStatus() {},
    addEvent() {},
    end() {},
  } as unknown as ISpan;
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

/** A client that lists `tools` until `down()` is called, then fails MCP_TRANSPORT. */
function switchableClient(
  tools: McpTool[],
): IMcpClient & { down(): void; calls: number } {
  let isDown = false;
  const c = {
    calls: 0,
    down() {
      isDown = true;
    },
    async listTools() {
      if (isDown) {
        return {
          ok: false as const,
          error: new McpError('down', 'MCP_TRANSPORT'),
        };
      }
      return { ok: true as const, value: tools };
    },
    async callTool() {
      c.calls++;
      return { ok: true as const, value: { content: 'result' } };
    },
  };
  return c;
}

function failedClient(): IMcpClient {
  return {
    async listTools() {
      return {
        ok: false as const,
        error: new McpError('down', 'MCP_TRANSPORT'),
      };
    },
    async callTool() {
      return { ok: true as const, value: { content: 'x' } };
    },
  };
}

/** A store whose query answers `result()`. */
function store(
  result: () => Result<RagResult[], RagError>,
): IRag & { queries: number } {
  const s = {
    queries: 0,
    async query() {
      s.queries++;
      return result();
    },
    async healthCheck() {
      return { ok: true as const, value: undefined };
    },
    async getById() {
      return { ok: true as const, value: null };
    },
  };
  return s as unknown as IRag & { queries: number };
}

const circuitOpen = (): Result<RagResult[], RagError> => ({
  ok: false,
  error: new RagError('open', 'CIRCUIT_OPEN'),
});

// ---------------------------------------------------------------------------
// M5 — through DefaultPipeline
// ---------------------------------------------------------------------------

describe('M5 tool-select: a client that cannot list fails the request', () => {
  it('two clients, one down → the consumer receives MCP_UNAVAILABLE', async () => {
    const llm = {
      model: 'm',
      async chat(): Promise<Result<LlmResponse, LlmError>> {
        return { ok: true, value: { content: 'x', finishReason: 'stop' } };
      },
      async *streamChat(): AsyncIterable<Result<LlmStreamChunk, LlmError>> {
        yield { ok: true, value: { content: 'answer', finishReason: 'stop' } };
      },
    } as ILlm;
    const { deps } = makeDefaultDeps({
      mcpClients: [makeMcpClient([SEARCH]), failedClient()],
    });
    const pipeline = new DefaultPipeline();
    pipeline.initialize({
      ...deps,
      mainLlm: llm,
      agentConfig: { mode: 'smart', maxIterations: 5 },
    } as never);
    const agent = new SmartAgent(
      { ...deps, mainLlm: llm, pipeline },
      { maxIterations: 5, mode: 'smart' },
    );
    const r = await agent.process('find something');
    assert.ok(!r.ok, 'the request ran with one client’s tools');
    assert.equal(r.error.code, 'MCP_UNAVAILABLE');
    assert.match(r.error.message, /MCP_TRANSPORT/);
  });
});

// ---------------------------------------------------------------------------
// M7 — tool-select discovery store query
// ---------------------------------------------------------------------------

function selectCtx(tools: IRag) {
  return {
    config: { mode: 'smart' },
    mcpTools: [] as McpTool[],
    mcpClients: [makeMcpClient([SEARCH])],
    toolClientMap: new Map<string, IMcpClient>(),
    ragResults: {},
    ragStores: { tools },
    externalTools: [] as LlmTool[],
    inputText: 'q',
    sessionId: 's1',
    options: {},
    toolAvailabilityRegistry: new ToolAvailabilityRegistry(),
    selectedTools: [] as LlmTool[],
    activeTools: [] as LlmTool[],
  } as unknown as PipelineContext;
}

describe('M7 tool-select: a failed discovery query fails the stage', () => {
  it('store ok:false CIRCUIT_OPEN → stage fails with CIRCUIT_OPEN naming the store', async () => {
    const ctx = selectCtx(store(circuitOpen));
    const ok = await new ToolSelectHandler().execute(ctx, {}, makeSpan());
    assert.equal(ok, false);
    assert.ok(ctx.error instanceof OrchestratorError);
    assert.equal(ctx.error.code, 'CIRCUIT_OPEN');
    assert.match(ctx.error.message, /store "tools"/);
  });

  it('store ok:true [] in smart mode → zero MCP tools and no error (honest empty answer)', async () => {
    const ctx = selectCtx(store(() => ({ ok: true, value: [] })));
    const ok = await new ToolSelectHandler().execute(ctx, {}, makeSpan());
    assert.equal(ok, true);
    assert.equal(ctx.error, undefined);
    assert.equal(ctx.selectedTools.length, 0);
  });
});

// ---------------------------------------------------------------------------
// M6, M8 — tool-loop
// ---------------------------------------------------------------------------

function loopCtx(opts: {
  clients: IMcpClient[];
  tools: LlmTool[];
  toolClientMap: Map<string, IMcpClient>;
  firstCall: string;
  refresh: boolean;
  reselect: boolean;
  toolsStore?: IRag;
  captured: LlmTool[][];
}): PipelineContext {
  let callIdx = 0;
  const streams = [
    async function* () {
      yield {
        ok: true,
        value: {
          content: '',
          toolCalls: [
            { index: 0, id: 'tc_1', name: opts.firstCall, arguments: '{}' },
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
  return {
    config: {
      maxIterations: 5,
      maxToolCalls: 5,
      heartbeatIntervalMs: 5000,
      mode: 'smart',
      refreshToolsPerIteration: opts.refresh,
      toolReselectPerIteration: opts.reselect,
    } as PipelineContext['config'],
    options: {} as CallOptions,
    sessionId: 'fail-loud',
    mcpClients: opts.clients,
    mcpClientDescriptors: opts.clients.map((_, i) => ({ slotIndex: i })),
    mainLlm: {} as ILlm,
    inputText: 'do it',
    history: [] as Message[],
    assembledMessages: [
      { role: 'system' as const, content: 'sys' },
      { role: 'user' as const, content: 'do it' },
    ] as Message[],
    activeTools: opts.tools,
    externalTools: [] as LlmTool[],
    selectedTools: [] as LlmTool[],
    mcpTools: opts.tools as McpTool[],
    toolClientMap: opts.toolClientMap,
    toolCache: new NoopToolCache(),
    ragStores: opts.toolsStore ? { tools: opts.toolsStore } : {},
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
      call(_llm: ILlm, _m: Message[], tools: LlmTool[]) {
        opts.captured.push([...tools]);
        const fn = streams[callIdx] ?? streams[streams.length - 1];
        callIdx += 1;
        return fn();
      },
    } as unknown as PipelineContext['llmCallStrategy'],
    yield() {},
  } as unknown as PipelineContext;
}

describe('M6 tool-loop: a per-iteration re-list failure fails the stage', () => {
  it('one client down at the refresh → MCP_UNAVAILABLE; the tool set is not shrunk first', async () => {
    const a = switchableClient([SEARCH]);
    const b = switchableClient([UPDATE]);
    // b goes down as soon as the first tool runs — the refresh before the
    // second LLM call then fails for it.
    const origCall = a.callTool.bind(a);
    a.callTool = async (...args: Parameters<IMcpClient['callTool']>) => {
      b.down();
      return origCall(...args);
    };
    const captured: LlmTool[][] = [];
    const ctx = loopCtx({
      clients: [a, b],
      tools: [SEARCH, UPDATE] as LlmTool[],
      toolClientMap: new Map<string, IMcpClient>([
        ['SearchA', a],
        ['UpdateB', b],
      ]),
      firstCall: 'SearchA',
      refresh: true,
      reselect: false,
      captured,
    });
    const ok = await new ToolLoopHandler().execute(ctx, {}, makeSpan());
    assert.equal(ok, false);
    assert.ok(ctx.error instanceof OrchestratorError);
    assert.equal(ctx.error.code, 'MCP_UNAVAILABLE');
    assert.equal(captured.length, 1, 'no LLM call went out with a shrunk set');
    assert.deepEqual(
      [...ctx.toolClientMap.keys()].sort(),
      ['SearchA', 'UpdateB'],
      'the tool set was not shrunk by the failure',
    );
  });
});

describe('M8 tool-loop: a failed re-select query fails the stage', () => {
  it('tools store CIRCUIT_OPEN at the re-select → stage fails with CIRCUIT_OPEN', async () => {
    const a = switchableClient([UPDATE]);
    const captured: LlmTool[][] = [];
    const toolsStore = store(circuitOpen);
    const ctx = loopCtx({
      clients: [a],
      tools: [UPDATE] as LlmTool[],
      toolClientMap: new Map<string, IMcpClient>([['UpdateB', a]]),
      firstCall: 'UpdateB',
      refresh: false,
      reselect: true,
      toolsStore,
      captured,
    });
    const ok = await new ToolLoopHandler().execute(ctx, {}, makeSpan());
    assert.equal(ok, false);
    assert.ok(ctx.error instanceof OrchestratorError);
    assert.equal(ctx.error.code, 'CIRCUIT_OPEN');
    assert.equal(toolsStore.queries, 1);
    assert.equal(captured.length, 1, 'no LLM call with the previous set');
  });
});

// ---------------------------------------------------------------------------
// M6/M8 — legacy SmartAgent loop (agent.ts, no pipeline)
// ---------------------------------------------------------------------------

function toolThenAnswerLlm(toolName: string): ILlm & { calls: number } {
  const llm = {
    calls: 0,
    model: 'm',
    async chat(): Promise<Result<LlmResponse, LlmError>> {
      return { ok: true, value: { content: 'x', finishReason: 'stop' } };
    },
    async *streamChat(): AsyncIterable<Result<LlmStreamChunk, LlmError>> {
      llm.calls++;
      if (llm.calls === 1) {
        yield {
          ok: true,
          value: {
            content: '',
            toolCalls: [
              { index: 0, id: 'c1', name: toolName, arguments: '{}' },
            ],
            finishReason: 'tool_calls',
          },
        };
        return;
      }
      yield { ok: true, value: { content: 'done', finishReason: 'stop' } };
    },
  };
  return llm as ILlm & { calls: number };
}

describe('M8 legacy loop (agent.ts): a failed re-select query fails the request', () => {
  it('tools store fails at the re-select → ok:false with the store’s code', async () => {
    let failing = false;
    const toolsStore = store(() =>
      failing ? circuitOpen() : { ok: true, value: [] },
    );
    const client = switchableClient([UPDATE]);
    const origCall = client.callTool.bind(client);
    client.callTool = async (...args: Parameters<IMcpClient['callTool']>) => {
      failing = true;
      return origCall(...args);
    };
    const llm = toolThenAnswerLlm('UpdateB');
    const { deps } = makeDefaultDeps({
      mcpClients: [client],
      ragStores: { tools: toolsStore },
    });
    const agent = new SmartAgent(
      { ...deps, mainLlm: llm },
      {
        maxIterations: 5,
        mode: 'hard',
        refreshToolsPerIteration: false,
        toolReselectPerIteration: true,
      },
    );
    const r = await agent.process('update it');
    assert.ok(!r.ok, 'the previous tool set was kept');
    assert.equal(r.error.code, 'CIRCUIT_OPEN');
    assert.equal(llm.calls, 1);
  });

  it('a client down at the per-iteration refresh → ok:false MCP_UNAVAILABLE', async () => {
    const client = switchableClient([UPDATE]);
    const origCall = client.callTool.bind(client);
    client.callTool = async (...args: Parameters<IMcpClient['callTool']>) => {
      client.down();
      return origCall(...args);
    };
    const llm = toolThenAnswerLlm('UpdateB');
    const { deps } = makeDefaultDeps({ mcpClients: [client] });
    const agent = new SmartAgent(
      { ...deps, mainLlm: llm },
      { maxIterations: 5, mode: 'hard' },
    );
    const r = await agent.process('update it');
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'MCP_UNAVAILABLE');
    assert.equal(llm.calls, 1);
  });
});
