import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  externalToolCallId,
  type IKnowledgeRagHandle,
  type KnowledgeEntry,
  type LlmStreamChunk,
  type LlmTool,
  type Message,
  type Result,
} from '@mcp-abap-adt/llm-agent';
import type {
  KnowledgeBackend,
  PipelineContext,
} from '@mcp-abap-adt/llm-agent-libs';
import {
  InMemoryKnowledgeBackend,
  SessionRequestLogger,
} from '@mcp-abap-adt/llm-agent-libs';
import {
  ControllerCoordinatorHandler,
  type ControllerHandlerDeps,
  parseNextStep,
} from '../controller-coordinator-handler.js';
import { hydrateBundle, persistBundle } from '../session-bundle.js';
import type { ISubagentClient } from '../subagent-client.js';
import type {
  ControllerConfig,
  IControllerPlanner,
  NextStep,
  SessionBundle,
  SubagentResult,
} from '../types.js';

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

type Captured = Result<LlmStreamChunk, unknown>;

function fakeCtx(overrides: Partial<PipelineContext> = {}): {
  ctx: PipelineContext;
  captured: Captured[];
} {
  const captured: Captured[] = [];
  const requestLogger = new SessionRequestLogger();
  requestLogger.startRequest('sess-1');
  const ctx = {
    sessionId: 'sess-1',
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

/** Subagent stub backed by a scripted queue; each send() shifts one result. */
function scriptedClient(queue: SubagentResult[]): ISubagentClient & {
  calls: number;
} {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async send() {
      calls++;
      const next = queue.shift();
      if (!next) return { kind: 'content', content: '' };
      return next;
    },
  };
}

function stubRag(
  queryImpl?: IKnowledgeRagHandle['query'],
): IKnowledgeRagHandle & { written: KnowledgeEntry[] } {
  const written: KnowledgeEntry[] = [];
  return {
    written,
    query: queryImpl ?? (async () => []),
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

interface Harness {
  deps: ControllerHandlerDeps;
  planner: ReturnType<typeof scriptedClient>;
  rag: ReturnType<typeof stubRag>;
  backend: InMemoryKnowledgeBackend;
  mcpCalls: Array<{ name: string; args: unknown }>;
}

function harness(opts: {
  evaluator: SubagentResult[];
  planner: SubagentResult[];
  executor: SubagentResult[];
  isExternalTool?: (n: string) => boolean;
  callMcpReturns?: string | { text: string; isError: boolean };
  config?: ControllerConfig;
  embedder?: never;
  ragQuery?: IKnowledgeRagHandle['query'];
  /** Tools surfaced by the (stubbed) semantic selector for every query. */
  selectTools?: LlmTool[];
}): Harness {
  const backend = new InMemoryKnowledgeBackend();
  const rag = stubRag(opts.ragQuery);
  const mcpCalls: Array<{ name: string; args: unknown }> = [];
  const planner = scriptedClient(opts.planner);
  const deps: ControllerHandlerDeps = {
    evaluator: scriptedClient(opts.evaluator),
    planner,
    executor: scriptedClient(opts.executor),
    backend,
    knowledgeRagFor: () => rag,
    embedder: opts.embedder ?? stubEmbedder,
    callMcp: async (name, args) => {
      mcpCalls.push({ name, args });
      const r = opts.callMcpReturns ?? 'mcp-out';
      return typeof r === 'string' ? { text: r, isError: false } : r;
    },
    selectTools: async () => opts.selectTools ?? [],
    // isExternalTool is left undefined by default so the per-request
    // ctx.externalTools is the routing truth; tests that need forced routing
    // pass it explicitly.
    ...(opts.isExternalTool ? { isExternalTool: opts.isExternalTool } : {}),
    config: opts.config ?? baseConfig(),
    models: { evaluator: 'm-eval', planner: 'm-plan', executor: 'm-exec' },
  };
  return { deps, planner, rag, backend, mcpCalls };
}

const toolCall = (
  name: string,
  args: Record<string, unknown>,
): SubagentResult => ({
  kind: 'tool_call',
  toolCalls: [{ id: 'c1', name, arguments: args }],
});

// ---------------------------------------------------------------------------
// #243 no-response safety-net
// ---------------------------------------------------------------------------
import { hydrateBundle } from '../session-bundle.js';
import { readTerminal } from '../run-scope.js';
import { GENERIC_NO_ANSWER } from '../controller-coordinator-handler.js';

function surfacedContent(
  captured: ReturnType<typeof fakeCtx>['captured'],
): string | undefined {
  const c = captured.find(
    (x): x is { ok: true; value: { content: string } } =>
      x.ok === true &&
      typeof (x.value as { content?: unknown }).content === 'string',
  );
  return c?.value.content;
}


describe('#243 empty-success guard (Layer 2)', () => {
  it('an empty finalizer answer → error terminal + non-empty body, and replay returns the same', async () => {
    // A run reaching finalize with an empty answer (finalize reply ''), no
    // captured failure → GENERIC_NO_ANSWER.
    const h = harness({
      evaluator: [{ kind: 'content', content: 'Goal: do it' }],
      planner: [
        {
          kind: 'content',
          content: JSON.stringify({
            plan: [{ name: 's1', instructions: 'go' }],
          }),
        },
        { kind: 'content', content: '' }, // finalize → EMPTY
      ],
      executor: [{ kind: 'content', content: 'did s1' }],
    });
    const { ctx, captured } = fakeCtx();
    await new ControllerCoordinatorHandler(h.deps).execute(ctx, {}, undefined);

    const body = surfacedContent(captured);
    assert.ok(body);
    assert.notEqual(body.trim(), '', 'never an empty body');
    assert.match(body, new RegExp(GENERIC_NO_ANSWER));

    const bundle = await hydrateBundle(h.backend, 'sess-1');
    const term = await readTerminal(
      h.backend,
      'sess-1',
      // biome-ignore lint/style/noNonNullAssertion: runId set after execute
      bundle.runId!,
      new Date().toISOString(),
    );
    assert.equal(term?.kind, 'error');

    // Replay must return the SAME durable error, not merely something non-empty.
    const replay = fakeCtx({
      options: { runId: bundle.runId },
    } as never);
    await new ControllerCoordinatorHandler(h.deps).execute(
      replay.ctx,
      {},
      undefined,
    );
    const replayBody = surfacedContent(replay.captured);
    assert.ok(replayBody);
    assert.equal(replayBody, body);
    assert.equal(replayBody, `Error: ${GENERIC_NO_ANSWER}`);
  });

  it('Symptom A: a tool error whose replan yields no legit answer surfaces the real error, never empty', async () => {
    // control-failure(tool error) → empty replan → finalizer returns EMPTY →
    // Layer 2 writes an error terminal carrying the captured tool text.
    const h = harness({
      evaluator: [
        { kind: 'content', content: 'Goal: read a class, report errors' },
      ],
      planner: [
        {
          kind: 'content',
          content: JSON.stringify({
            plan: [{ name: 's1', instructions: 'read' }],
          }),
        },
        { kind: 'content', content: JSON.stringify({ plan: [] }) }, // replan → empty
        { kind: 'content', content: '' }, // finalizer → EMPTY (no progress)
      ],
      executor: [toolCall('ReadClass', { name: 'ZZ_QX9B7' })],
      isExternalTool: () => false,
      selectTools: [{ name: 'ReadClass', description: '', inputSchema: {} }],
      callMcpReturns: { text: 'Class ZZ_QX9B7 not found', isError: true },
    });
    const { ctx, captured } = fakeCtx();
    await new ControllerCoordinatorHandler(h.deps).execute(ctx, {}, undefined);

    const body = surfacedContent(captured);
    assert.ok(body);
    assert.notEqual(body.trim(), '', 'never (no response)');
    assert.match(body, /Class ZZ_QX9B7 not found/);

    const bundle = await hydrateBundle(h.backend, 'sess-1');
    const term = await readTerminal(
      h.backend,
      'sess-1',
      // biome-ignore lint/style/noNonNullAssertion: runId set after execute
      bundle.runId!,
      new Date().toISOString(),
    );
    assert.equal(term?.kind, 'error');
  });
});
