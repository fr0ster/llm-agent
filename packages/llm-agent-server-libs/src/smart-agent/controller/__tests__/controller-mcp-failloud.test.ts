/**
 * Task 3 confirming test: a thrown McpError from deps.callMcp during the
 * executor step MUST surface as a loud terminal failure (not empty / silent).
 *
 * Before the fix the McpError propagated out of execute() uncaught, and the
 * pipeline's catch block swallowed it → client saw (no response).
 * After the fix the handler catches it and calls abortTerminal which calls
 * surfaceFinal → the client sees 'Error: MCP server unavailable: ...'.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type IKnowledgeRagHandle,
  type KnowledgeEntry,
  type LlmStreamChunk,
  type LlmTool,
  McpError,
  type Result,
} from '@mcp-abap-adt/llm-agent';
import type { PipelineContext } from '@mcp-abap-adt/llm-agent-libs';
import {
  InMemoryKnowledgeBackend,
  SessionRequestLogger,
} from '@mcp-abap-adt/llm-agent-libs';
import {
  ControllerCoordinatorHandler,
  type ControllerHandlerDeps,
} from '../controller-coordinator-handler.js';
import type { ISubagentClient } from '../subagent-client.js';
import type { ControllerConfig, SubagentResult } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers (mirrors controller-coordinator-handler.test.ts)
// ---------------------------------------------------------------------------

type Captured = Result<LlmStreamChunk, unknown>;

function fakeCtx(overrides: Partial<PipelineContext> = {}): {
  ctx: PipelineContext;
  captured: Captured[];
} {
  const captured: Captured[] = [];
  const requestLogger = new SessionRequestLogger();
  requestLogger.startRequest('sess-mcp');
  const ctx = {
    sessionId: 'sess-mcp',
    textOrMessages: 'do the thing',
    options: undefined,
    externalResults: undefined,
    requestLogger,
    yield: (c: Captured) => {
      captured.push(c);
    },
    ...overrides,
  } as unknown as PipelineContext;
  return { ctx, captured };
}

function scriptedClient(queue: SubagentResult[]): ISubagentClient {
  return {
    async send() {
      const next = queue.shift();
      if (!next) return { kind: 'content', content: '' };
      return next;
    },
  };
}

function stubRag(): IKnowledgeRagHandle & { written: KnowledgeEntry[] } {
  const written: KnowledgeEntry[] = [];
  return {
    written,
    query: async () => [],
    async list() {
      return [];
    },
    async write(entry) {
      written.push(entry);
    },
    fingerprint() {
      return 'stub';
    },
  };
}

const stubEmbedder = {
  embed: async () => ({ vector: [1, 0, 0] }),
} as never;

function baseConfig(): ControllerConfig {
  return {
    subagents: {} as never,
    targetState: { strategy: 'semantic-distance', distanceThreshold: 0.9 },
    sessionMemory: { collection: 'controller' },
    budgets: { maxSteps: 10, maxRetries: 2, maxRewinds: 3 },
  };
}

const toolCall = (
  name: string,
  args: Record<string, unknown>,
): SubagentResult => ({
  kind: 'tool_call',
  toolCalls: [{ id: 'c1', name, arguments: args }],
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('controller MCP fail-loud (Task 3)', () => {
  it('Case A: callMcp rejects with unavailable McpError → loud terminal error (not silent)', async () => {
    const backend = new InMemoryKnowledgeBackend();
    const rag = stubRag();

    const unavailableError = new McpError(
      'MCP server down',
      'MCP_NOT_CONNECTED',
    );

    const deps: ControllerHandlerDeps = {
      evaluator: scriptedClient([
        { kind: 'content', content: 'Goal: do the thing' },
      ]),
      planner: scriptedClient([
        {
          kind: 'content',
          content: JSON.stringify({
            plan: [{ name: 's1', instructions: 'fetch data' }],
          }),
        },
        // finalize (may not be reached)
        { kind: 'content', content: 'done' },
      ]),
      executor: scriptedClient([
        // First: issue a tool call for the internal tool
        toolCall('GetTable', { table: 'T' }),
        // Second: never reached — callMcp throws
        { kind: 'content', content: 'result' },
      ]),
      backend,
      knowledgeRagFor: () => rag,
      embedder: stubEmbedder,
      callMcp: async (_name, _args) => {
        // Reject with an unavailable McpError — the bug: this throw was swallowed.
        return Promise.reject(unavailableError);
      },
      selectTools: async (): Promise<LlmTool[]> => [
        // Offer GetTable so offeredInternalNames includes it.
        { name: 'GetTable', description: '', inputSchema: {} },
      ],
      isExternalTool: () => false,
      config: baseConfig(),
      models: { evaluator: 'm-eval', planner: 'm-plan', executor: 'm-exec' },
    };

    const handler = new ControllerCoordinatorHandler(deps);
    const { ctx, captured } = fakeCtx();

    // Must NOT throw (the fix catches the McpError and surfaces it).
    const ret = await handler.execute(ctx, {}, undefined);

    assert.equal(
      ret,
      true,
      'execute() must return true (handled, not unhandled throw)',
    );

    // The run must surface a LOUD error — at minimum one chunk with content
    // containing the MCP error message (via abortTerminal → surfaceFinal).
    const errorChunk = captured.find(
      (c) =>
        c.ok &&
        typeof c.value.content === 'string' &&
        c.value.content.includes('MCP server unavailable') &&
        c.value.finishReason === 'stop',
    );
    assert.ok(
      errorChunk,
      `Expected a stop chunk containing "MCP server unavailable" but got: ${JSON.stringify(captured)}`,
    );
  });

  it('Case B: callMcp returns a tool-level error string → executor receives it as feedback (unchanged)', async () => {
    const backend = new InMemoryKnowledgeBackend();
    const rag = stubRag();
    const mcpCalls: Array<{ name: string; args: unknown }> = [];

    const deps: ControllerHandlerDeps = {
      evaluator: scriptedClient([
        { kind: 'content', content: 'Goal: do the thing' },
      ]),
      planner: scriptedClient([
        {
          kind: 'content',
          content: JSON.stringify({
            plan: [{ name: 's1', instructions: 'fetch data' }],
          }),
        },
        { kind: 'content', content: 'final answer' },
      ]),
      executor: scriptedClient([
        toolCall('GetTable', { table: 'T' }),
        // After receiving the tool error text as feedback, executor finishes.
        { kind: 'content', content: 'saw error, done' },
      ]),
      backend,
      knowledgeRagFor: () => rag,
      embedder: stubEmbedder,
      callMcp: async (name, args) => {
        // Non-throw: return an error string (tool-level failure fed back to LLM).
        mcpCalls.push({ name, args });
        return 'table not found';
      },
      selectTools: async (): Promise<LlmTool[]> => [
        { name: 'GetTable', description: '', inputSchema: {} },
      ],
      isExternalTool: () => false,
      config: baseConfig(),
      models: { evaluator: 'm-eval', planner: 'm-plan', executor: 'm-exec' },
    };

    const handler = new ControllerCoordinatorHandler(deps);
    const { ctx, captured } = fakeCtx();

    const ret = await handler.execute(ctx, {}, undefined);

    assert.equal(ret, true);
    // callMcp was called (the tool error was fed back, not aborted).
    assert.equal(mcpCalls.length, 1, 'callMcp must be called once');
    assert.equal(mcpCalls[0]?.name, 'GetTable');

    // The run finishes normally with the finalizer output.
    const finalChunk = captured.find(
      (c) =>
        c.ok &&
        typeof c.value.content === 'string' &&
        c.value.content === 'final answer' &&
        c.value.finishReason === 'stop',
    );
    assert.ok(
      finalChunk,
      `Expected final "final answer" chunk but got: ${JSON.stringify(captured)}`,
    );
  });
});
