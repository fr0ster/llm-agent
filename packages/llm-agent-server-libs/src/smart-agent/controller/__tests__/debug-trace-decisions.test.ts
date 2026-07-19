/**
 * #213 Task 5: controller decision (+ MCP + RAG) debug-trace capture.
 *
 * Confirms `logDecision` fires a `controller_decision_<kind>` record (area
 * `controller`) with a `reason` field whenever the controller replans or
 * hits a control-level failure, and that the MCP bridge / step recall emit
 * `mcp_tool_call` (area `mcp`) / `rag_recall` (area `rag`) records. All of
 * this is observability-only: the run's outcome is unaffected, and the
 * added `logStep` calls are a no-op when no sessionLogger is wired (see
 * `controller-coordinator-handler.test.ts` / `round-trip.test.ts`, which
 * still pass unmodified).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  IKnowledgeRagHandle,
  KnowledgeEntry,
  LlmStreamChunk,
  LlmTool,
  Result,
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
// Helpers (mirrors controller-mcp-failloud.test.ts)
// ---------------------------------------------------------------------------

type Captured = Result<LlmStreamChunk, unknown>;

type CapturedStep = { name: string; area?: string; data: unknown };

function fakeCtx(overrides: Partial<PipelineContext> = {}): {
  ctx: PipelineContext;
  captured: Captured[];
  steps: CapturedStep[];
} {
  const captured: Captured[] = [];
  const steps: CapturedStep[] = [];
  const requestLogger = new SessionRequestLogger();
  requestLogger.startRequest('sess-decisions');
  const sessionLogger = {
    logStep: (name: string, data: unknown, area?: string) => {
      steps.push({ name, area, data });
    },
  };
  const ctx = {
    sessionId: 'sess-decisions',
    textOrMessages: 'do the thing',
    options: { sessionLogger },
    externalResults: undefined,
    requestLogger,
    yield: (c: Captured) => {
      captured.push(c);
    },
    ...overrides,
  } as unknown as PipelineContext;
  return { ctx, captured, steps };
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
    // maxRetries: 0 → the executor's first error is immediately exhausted
    // (retries=1 > maxRetries=0), driving settle('failed') on the very first
    // attempt without needing to script multiple error rounds.
    budgets: { maxSteps: 10, maxRetries: 0, maxRewinds: 3 },
  };
}

/** Deps that make the executor error out on the step, forcing the controller
 *  down the "executor error exhausted → settle('failed')" replan path. */
function makeReplanningDeps(
  mcpCalls: Array<{ name: string; args: unknown }>,
): ControllerHandlerDeps {
  const backend = new InMemoryKnowledgeBackend();
  const rag = stubRag();

  return {
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
      // The replan after the failed step 's1' — the planner is asked again
      // and this time signals done so the run terminates cleanly.
      {
        kind: 'content',
        content: JSON.stringify({ done: true, result: 'final answer' }),
      },
    ]),
    executor: scriptedClient([
      // First round: an internal tool call so the MCP bridge fires (covers
      // the mcp_tool_call / rag_recall capture too).
      {
        kind: 'tool_call',
        toolCalls: [{ id: 'c1', name: 'GetTable', arguments: { table: 'T' } }],
      },
      // Second round: the executor errors out → exhausted immediately
      // (maxRetries: 0) → settle('failed') → replan decision.
      { kind: 'error', error: 'boom' },
    ]),
    backend,
    knowledgeRagFor: () => rag,
    embedder: stubEmbedder,
    callMcp: async (name, args) => {
      mcpCalls.push({ name, args });
      return 'table contents';
    },
    selectTools: async (): Promise<LlmTool[]> => [
      { name: 'GetTable', description: '', inputSchema: {} },
    ],
    isExternalTool: () => false,
    config: baseConfig(),
    models: { evaluator: 'm-eval', planner: 'm-plan', executor: 'm-exec' },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('debug-trace controller decision / MCP / RAG capture (Task 5, #213)', () => {
  it('a replan decision emits a controller_decision record with reason (area controller)', async () => {
    const mcpCalls: Array<{ name: string; args: unknown }> = [];
    const handler = new ControllerCoordinatorHandler(
      makeReplanningDeps(mcpCalls),
    );
    const { ctx, steps } = fakeCtx();

    await handler.execute(ctx, {}, undefined);

    const d = steps.find(
      (s) =>
        s.name.startsWith('controller_decision') && s.area === 'controller',
    );
    assert.ok(
      d,
      `expected a controller_decision record, got: ${JSON.stringify(steps.map((s) => s.name))}`,
    );
    assert.ok((d?.data as { reason?: string }).reason, 'it carries a reason');
  });

  it('the target-state establishment emits a controller_decision_target-state record', async () => {
    const mcpCalls: Array<{ name: string; args: unknown }> = [];
    const handler = new ControllerCoordinatorHandler(
      makeReplanningDeps(mcpCalls),
    );
    const { ctx, steps } = fakeCtx();

    await handler.execute(ctx, {}, undefined);

    const d = steps.find(
      (s) =>
        s.name === 'controller_decision_target-state' &&
        s.area === 'controller',
    );
    assert.ok(d, 'expected a target-state decision record');
    assert.ok((d?.data as { reason?: string }).reason, 'it carries a reason');
  });

  it('the controller MCP bridge emits an mcp_tool_call record (area mcp)', async () => {
    const mcpCalls: Array<{ name: string; args: unknown }> = [];
    const handler = new ControllerCoordinatorHandler(
      makeReplanningDeps(mcpCalls),
    );
    const { ctx, steps } = fakeCtx();

    await handler.execute(ctx, {}, undefined);

    assert.equal(mcpCalls.length, 1, 'callMcp must have been invoked once');
    const m = steps.find((s) => s.name === 'mcp_tool_call' && s.area === 'mcp');
    assert.ok(
      m,
      `expected an mcp_tool_call record, got: ${JSON.stringify(steps.map((s) => s.name))}`,
    );
    assert.equal((m?.data as { name?: string }).name, 'GetTable');
  });

  it('the controller step recall emits a rag_recall record (area rag)', async () => {
    const mcpCalls: Array<{ name: string; args: unknown }> = [];
    const handler = new ControllerCoordinatorHandler(
      makeReplanningDeps(mcpCalls),
    );
    const { ctx, steps } = fakeCtx();

    await handler.execute(ctx, {}, undefined);

    const r = steps.find((s) => s.name === 'rag_recall' && s.area === 'rag');
    assert.ok(
      r,
      `expected a rag_recall record, got: ${JSON.stringify(steps.map((s) => s.name))}`,
    );
    assert.ok(
      (r?.data as { query?: string }).query,
      'it carries the recall query',
    );
  });

  it('no sessionLogger wired → the added logStep calls are a no-op (no throw)', async () => {
    const mcpCalls: Array<{ name: string; args: unknown }> = [];
    const handler = new ControllerCoordinatorHandler(
      makeReplanningDeps(mcpCalls),
    );
    const backend = new InMemoryKnowledgeBackend();
    void backend;
    const requestLogger = new SessionRequestLogger();
    requestLogger.startRequest('sess-no-logger');
    const captured: Captured[] = [];
    const ctx = {
      sessionId: 'sess-no-logger',
      textOrMessages: 'do the thing',
      options: undefined,
      externalResults: undefined,
      requestLogger,
      yield: (c: Captured) => {
        captured.push(c);
      },
    } as unknown as PipelineContext;

    const ret = await handler.execute(ctx, {}, undefined);
    assert.equal(ret, true);
  });
});
