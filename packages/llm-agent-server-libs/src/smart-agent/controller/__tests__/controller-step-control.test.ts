/**
 * Task 7: per-step execution control in the controller `runStep` loop.
 *
 * The step budget (DefaultStepExecutionControl by default) must:
 *  (a) cut a non-converging (livelock) step by TIME → control-failure → replan;
 *  (b) map a hanging LLM whose executor.send rejects on signal-abort to
 *      control-failure('step-timeout') (NOT the executor-error retry path);
 *  (c) map a hanging MCP whose callMcp rejects on signal-abort to
 *      control-failure('step-timeout') (NOT an MCP-unavailable terminal abort);
 *  (d) enforce the prospective `+1` tool-call gate (a step reaching exactly
 *      maxToolCalls then returning content SETTLES; a further call is cut).
 *
 * Harness mirrors controller-mcp-failloud.test.ts.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  CallOptions,
  IKnowledgeRagHandle,
  IStepBudget,
  IStepExecutionControl,
  KnowledgeEntry,
  LlmStreamChunk,
  LlmTool,
  Message,
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
import { hydrateBundle } from '../session-bundle.js';
import type { ISubagentClient } from '../subagent-client.js';
import type { ControllerConfig, SubagentResult } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Captured = Result<LlmStreamChunk, unknown>;

function fakeCtx(overrides: Partial<PipelineContext> = {}): {
  ctx: PipelineContext;
  captured: Captured[];
} {
  const captured: Captured[] = [];
  const requestLogger = new SessionRequestLogger();
  requestLogger.startRequest('sess-step');
  const ctx = {
    sessionId: 'sess-step',
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

function baseConfig(
  over: Partial<ControllerConfig['budgets']> = {},
): ControllerConfig {
  return {
    subagents: {} as never,
    targetState: { strategy: 'semantic-distance', distanceThreshold: 0.9 },
    sessionMemory: { collection: 'controller' },
    budgets: { maxSteps: 10, maxRetries: 2, maxRewinds: 3, ...over },
  };
}

const toolCall = (
  name: string,
  args: Record<string, unknown>,
): SubagentResult => ({
  kind: 'tool_call',
  toolCalls: [{ id: 'c1', name, arguments: args }],
});

/** Executor that always issues the same internal tool call (never converges). */
function alwaysToolCall(name: string): ISubagentClient {
  return {
    async send() {
      return toolCall(name, {});
    },
  };
}

/** Executor whose send() never resolves until its options.signal aborts. */
function hangingLlmUntilAbort(): ISubagentClient {
  return {
    send(_m: Message[], _t?: LlmTool[], options?: CallOptions) {
      return new Promise<SubagentResult>((_resolve, reject) => {
        const s = options?.signal;
        if (s?.aborted) return reject(new Error('llm-aborted'));
        s?.addEventListener('abort', () => reject(new Error('llm-aborted')));
      });
    },
  };
}

const stopChunk = (captured: Captured[], content: string) =>
  captured.find(
    (c) =>
      c.ok &&
      typeof c.value.content === 'string' &&
      c.value.content === content &&
      c.value.finishReason === 'stop',
  );

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('controller per-step execution control (Task 7)', () => {
  it('(a) livelock cut: a never-converging step is cut by TIME → replan → completes', {
    timeout: 5000,
  }, async () => {
    const backend = new InMemoryKnowledgeBackend();
    const rag = stubRag();
    const deps: ControllerHandlerDeps = {
      evaluator: scriptedClient([{ kind: 'content', content: 'Goal' }]),
      planner: scriptedClient([
        {
          kind: 'content',
          content: JSON.stringify({
            plan: [{ name: 's1', instructions: 'do' }],
          }),
        },
        { kind: 'content', content: JSON.stringify({ plan: [] }) }, // replan → empty
        { kind: 'content', content: 'time-done' }, // finalize
      ]),
      // Never returns content → would loop unbounded without a budget.
      executor: alwaysToolCall('LoopTool'),
      backend,
      knowledgeRagFor: () => rag,
      embedder: stubEmbedder,
      // Quick MCP result with a tiny delay so wall-clock accrues.
      callMcp: async () => {
        await new Promise((r) => setTimeout(r, 5));
        return 'mcp-out';
      },
      selectTools: async (): Promise<LlmTool[]> => [
        { name: 'LoopTool', description: '', inputSchema: {} },
      ],
      isExternalTool: () => false,
      // High count cap so TIME (not count) is the cutter.
      config: baseConfig({ maxToolCalls: 50, perStepTimeoutMs: 20 }),
      models: { evaluator: 'm-eval', planner: 'm-plan', executor: 'm-exec' },
    };

    const handler = new ControllerCoordinatorHandler(deps);
    const { ctx, captured } = fakeCtx();
    const ret = await handler.execute(ctx, {}, undefined);

    assert.equal(ret, true);
    const bundle = await hydrateBundle(backend, 'sess-step');
    assert.equal(bundle.budgets.stepsUsed, 1, 'the cut step counted once');
    assert.ok(
      /step-timeout/.test(bundle.plannerPrivate),
      `expected a step-timeout control-failure note, got: ${bundle.plannerPrivate}`,
    );
    assert.ok(
      stopChunk(captured, 'time-done'),
      'the run replanned and completed instead of looping forever',
    );
  });

  it('(b) hanging LLM: executor.send rejects on abort → control-failure(step-timeout), not executor-error retry', {
    timeout: 5000,
  }, async () => {
    const backend = new InMemoryKnowledgeBackend();
    const rag = stubRag();
    const deps: ControllerHandlerDeps = {
      evaluator: scriptedClient([{ kind: 'content', content: 'Goal' }]),
      planner: scriptedClient([
        {
          kind: 'content',
          content: JSON.stringify({
            plan: [{ name: 's1', instructions: 'do' }],
          }),
        },
        { kind: 'content', content: JSON.stringify({ plan: [] }) },
        { kind: 'content', content: 'llm-timeout-done' },
      ]),
      executor: hangingLlmUntilAbort(),
      backend,
      knowledgeRagFor: () => rag,
      embedder: stubEmbedder,
      callMcp: async () => 'mcp-out',
      selectTools: async (): Promise<LlmTool[]> => [],
      isExternalTool: () => false,
      config: baseConfig({ perStepTimeoutMs: 25 }),
      models: { evaluator: 'm-eval', planner: 'm-plan', executor: 'm-exec' },
    };

    const handler = new ControllerCoordinatorHandler(deps);
    const { ctx, captured } = fakeCtx();
    const ret = await handler.execute(ctx, {}, undefined);

    assert.equal(ret, true);
    const bundle = await hydrateBundle(backend, 'sess-step');
    assert.ok(
      /step time budget exhausted \(step-timeout\)/.test(bundle.plannerPrivate),
      `expected a step-timeout note, got: ${bundle.plannerPrivate}`,
    );
    assert.ok(
      !/executor error/.test(bundle.plannerPrivate),
      'a hanging LLM must NOT be mapped to the executor-error retry path',
    );
    assert.ok(
      stopChunk(captured, 'llm-timeout-done'),
      'the run replanned and completed',
    );
  });

  it('(c) hanging MCP: callMcp rejects on abort → control-failure(step-timeout), not MCP-unavailable abort', {
    timeout: 5000,
  }, async () => {
    const backend = new InMemoryKnowledgeBackend();
    const rag = stubRag();
    const deps: ControllerHandlerDeps = {
      evaluator: scriptedClient([{ kind: 'content', content: 'Goal' }]),
      planner: scriptedClient([
        {
          kind: 'content',
          content: JSON.stringify({
            plan: [{ name: 's1', instructions: 'do' }],
          }),
        },
        { kind: 'content', content: JSON.stringify({ plan: [] }) },
        { kind: 'content', content: 'mcp-timeout-done' },
      ]),
      executor: scriptedClient([
        toolCall('GetTable', { table: 'T' }),
        { kind: 'content', content: 'never reached' },
      ]),
      backend,
      knowledgeRagFor: () => rag,
      embedder: stubEmbedder,
      // MCP hangs until the merged signal aborts (rejects with a plain Error,
      // NOT an McpError → must not be treated as MCP-unavailable).
      callMcp: (_name, _args, signal) =>
        new Promise<string>((_resolve, reject) => {
          if (signal?.aborted) return reject(new Error('mcp-aborted'));
          signal?.addEventListener('abort', () =>
            reject(new Error('mcp-aborted')),
          );
        }),
      selectTools: async (): Promise<LlmTool[]> => [
        { name: 'GetTable', description: '', inputSchema: {} },
      ],
      isExternalTool: () => false,
      config: baseConfig({ perStepTimeoutMs: 25 }),
      models: { evaluator: 'm-eval', planner: 'm-plan', executor: 'm-exec' },
    };

    const handler = new ControllerCoordinatorHandler(deps);
    const { ctx, captured } = fakeCtx();
    const ret = await handler.execute(ctx, {}, undefined);

    assert.equal(ret, true);
    const bundle = await hydrateBundle(backend, 'sess-step');
    assert.ok(
      /step time budget exhausted \(step-timeout\)/.test(bundle.plannerPrivate),
      `expected a step-timeout note, got: ${bundle.plannerPrivate}`,
    );
    assert.ok(
      !captured.some(
        (c) =>
          c.ok &&
          typeof c.value.content === 'string' &&
          c.value.content.includes('MCP server unavailable'),
      ),
      'a step-timeout MCP cancel must NOT surface as an MCP-unavailable abort',
    );
    assert.ok(
      stopChunk(captured, 'mcp-timeout-done'),
      'the run replanned and completed',
    );
  });

  it('(d1) count gate `+1`: a 3rd tool call beyond maxToolCalls=2 is cut (maxToolCalls) → replan', {
    timeout: 5000,
  }, async () => {
    const backend = new InMemoryKnowledgeBackend();
    const rag = stubRag();
    const deps: ControllerHandlerDeps = {
      evaluator: scriptedClient([{ kind: 'content', content: 'Goal' }]),
      planner: scriptedClient([
        {
          kind: 'content',
          content: JSON.stringify({
            plan: [{ name: 's1', instructions: 'do' }],
          }),
        },
        { kind: 'content', content: JSON.stringify({ plan: [] }) },
        { kind: 'content', content: 'count-done' },
      ]),
      executor: alwaysToolCall('LoopTool'),
      backend,
      knowledgeRagFor: () => rag,
      embedder: stubEmbedder,
      callMcp: async () => 'mcp-out',
      selectTools: async (): Promise<LlmTool[]> => [
        { name: 'LoopTool', description: '', inputSchema: {} },
      ],
      isExternalTool: () => false,
      config: baseConfig({ maxToolCalls: 2 }),
      models: { evaluator: 'm-eval', planner: 'm-plan', executor: 'm-exec' },
    };

    const mcpCalls: unknown[] = [];
    const origCall = deps.callMcp;
    deps.callMcp = async (n, a, s) => {
      mcpCalls.push(n);
      return origCall(n, a, s);
    };

    const handler = new ControllerCoordinatorHandler(deps);
    const { ctx, captured } = fakeCtx();
    const ret = await handler.execute(ctx, {}, undefined);

    assert.equal(ret, true);
    assert.ok(
      mcpCalls.length <= 2,
      `callMcp bounded by maxToolCalls (got ${mcpCalls.length})`,
    );
    const bundle = await hydrateBundle(backend, 'sess-step');
    assert.ok(
      /tool-call budget exhausted \(maxToolCalls\)/.test(bundle.plannerPrivate),
      `expected a maxToolCalls note, got: ${bundle.plannerPrivate}`,
    );
    assert.ok(
      stopChunk(captured, 'count-done'),
      'the run replanned and completed',
    );
  });

  it('(d2) count gate `+1`: a step reaching EXACTLY maxToolCalls=2 then content SETTLES (not cut)', {
    timeout: 5000,
  }, async () => {
    const backend = new InMemoryKnowledgeBackend();
    const rag = stubRag();
    const mcpCalls: unknown[] = [];
    const deps: ControllerHandlerDeps = {
      evaluator: scriptedClient([{ kind: 'content', content: 'Goal' }]),
      planner: scriptedClient([
        {
          kind: 'content',
          content: JSON.stringify({
            plan: [{ name: 's1', instructions: 'do' }],
          }),
        },
        { kind: 'content', content: 'settle-done' }, // finalize (no replan)
      ]),
      executor: scriptedClient([
        toolCall('LoopTool', {}),
        toolCall('LoopTool', {}),
        { kind: 'content', content: 'converged' },
      ]),
      backend,
      knowledgeRagFor: () => rag,
      embedder: stubEmbedder,
      callMcp: async (n) => {
        mcpCalls.push(n);
        return 'mcp-out';
      },
      selectTools: async (): Promise<LlmTool[]> => [
        { name: 'LoopTool', description: '', inputSchema: {} },
      ],
      isExternalTool: () => false,
      config: baseConfig({ maxToolCalls: 2 }),
      models: { evaluator: 'm-eval', planner: 'm-plan', executor: 'm-exec' },
    };

    const handler = new ControllerCoordinatorHandler(deps);
    const { ctx, captured } = fakeCtx();
    const ret = await handler.execute(ctx, {}, undefined);

    assert.equal(ret, true);
    assert.equal(mcpCalls.length, 2, 'exactly maxToolCalls tool calls ran');
    const bundle = await hydrateBundle(backend, 'sess-step');
    assert.ok(
      !/budget exhausted/.test(bundle.plannerPrivate),
      `a step reaching exactly maxToolCalls must NOT be cut, got: ${bundle.plannerPrivate}`,
    );
    assert.equal(bundle.budgets.stepsUsed, 1);
    assert.ok(
      stopChunk(captured, 'settle-done'),
      'the run settled and completed',
    );
  });

  it('(e) budget dispose on PRE-LOOP throw: a selectTools reject before the executor loop still disposes the step budget (no leaked timer)', {
    timeout: 5000,
  }, async () => {
    const backend = new InMemoryKnowledgeBackend();
    const rag = stubRag();

    // A budget with a SPY dispose and a never-firing signal (a plain
    // AbortController that is never aborted). If the pre-loop code throws before
    // the executor while-loop, dispose() must STILL be called (try opens right
    // after beginStep) — otherwise the un-unref'd real timer would leak.
    let disposeCalls = 0;
    const neverAbort = new AbortController();
    const stepExecutionControl: IStepExecutionControl = {
      beginStep(): IStepBudget {
        return {
          signal: neverAbort.signal,
          shouldContinueRound: () => ({ continue: true }),
          canExecuteTool: () => ({ continue: true }),
          dispose() {
            disposeCalls++;
          },
        };
      },
    };

    const boom = new Error('selectTools-boom');
    const deps: ControllerHandlerDeps = {
      evaluator: scriptedClient([{ kind: 'content', content: 'Goal' }]),
      planner: scriptedClient([
        {
          kind: 'content',
          content: JSON.stringify({
            plan: [{ name: 's1', instructions: 'do' }],
          }),
        },
      ]),
      // Never reached — selectTools throws in the budget-dependent PRE-LOOP.
      executor: scriptedClient([{ kind: 'content', content: 'unreached' }]),
      backend,
      knowledgeRagFor: () => rag,
      embedder: stubEmbedder,
      callMcp: async () => 'mcp-out',
      // Pre-loop await that rejects BEFORE the executor while-loop opens.
      selectTools: async (): Promise<LlmTool[]> => {
        throw boom;
      },
      isExternalTool: () => false,
      stepExecutionControl,
      config: baseConfig({ perStepTimeoutMs: 20 }),
      models: { evaluator: 'm-eval', planner: 'm-plan', executor: 'm-exec' },
    };

    const handler = new ControllerCoordinatorHandler(deps);
    const { ctx } = fakeCtx();

    // The throw must STILL propagate (behaviour unchanged) …
    await assert.rejects(
      () => handler.execute(ctx, {}, undefined),
      /selectTools-boom/,
    );
    // … AND the budget must have been disposed on the way out (the fix).
    assert.equal(
      disposeCalls,
      1,
      'budget.dispose() must run even when a PRE-LOOP await throws',
    );
  });
});
