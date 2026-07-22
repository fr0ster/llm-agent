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
  const deps: ControllerHandlerDeps = {
    evaluator: scriptedClient(opts.evaluator),
    planner: scriptedClient(opts.planner),
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
  return { deps, rag, backend, mcpCalls };
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

describe('ControllerCoordinatorHandler', () => {
  it('happy: goal → one step → done', async () => {
    const h = harness({
      evaluator: [{ kind: 'content', content: 'Goal: do the thing' }],
      planner: [
        // create-plan (plan-first): the full plan in one reply
        {
          kind: 'content',
          content: JSON.stringify({
            plan: [{ name: 's1', instructions: 'do' }],
          }),
        },
        // finalize: FINALIZE_SYSTEM returns PLAIN TEXT → becomes the done result
        { kind: 'content', content: 'finished' },
      ],
      executor: [{ kind: 'content', content: 'did s1' }],
    });
    const handler = new ControllerCoordinatorHandler(h.deps);
    const { ctx, captured } = fakeCtx();

    const ret = await handler.execute(ctx, {}, undefined);

    assert.equal(ret, true);
    const final = captured.find(
      (c) =>
        c.ok &&
        c.value.finishReason === 'stop' &&
        c.value.content === 'finished',
    );
    assert.ok(final, 'final stop chunk with content "finished"');
    const bundle = await hydrateBundle(h.backend, 'sess-1');
    assert.equal(bundle.budgets.stepsUsed, 1);
    assert.equal(bundle.pending, undefined);
  });

  it('internal tool: executor tool_call → callMcp → re-send → done', async () => {
    const h = harness({
      evaluator: [{ kind: 'content', content: 'Goal' }],
      planner: [
        {
          kind: 'content',
          content: JSON.stringify({
            plan: [{ name: 's1', instructions: 'do' }],
          }),
        },
        { kind: 'content', content: 'final-out' },
      ],
      executor: [
        toolCall('GetX', { id: 1 }),
        { kind: 'content', content: 'used tool' },
      ],
      selectTools: [{ name: 'GetX', description: '', inputSchema: {} }],
      isExternalTool: () => false,
      callMcpReturns: 'mcp-out',
    });
    const handler = new ControllerCoordinatorHandler(h.deps);
    const { ctx, captured } = fakeCtx();

    const ret = await handler.execute(ctx, {}, undefined);

    assert.equal(ret, true);
    assert.equal(h.mcpCalls.length, 1);
    assert.equal(h.mcpCalls[0].name, 'GetX');
    assert.ok(
      captured.find(
        (c) =>
          c.ok &&
          c.value.finishReason === 'stop' &&
          c.value.content === 'final-out',
      ),
    );
    // NOTE (Task 11): the handler no longer writes the mcp-result artifact itself —
    // recording the tool round is the injected context strategy's job. The default
    // (LegacyAccumulate) strategy keeps rounds in-memory and writes nothing; the
    // production controller wires RagRecall (Task 13) which persists the mcp-result.
    // So under the default strategy no mcp-result artifact is expected here.
  });

  it('external tool: surfaces tool_calls chunk + suspends with pending marker', async () => {
    const h = harness({
      evaluator: [{ kind: 'content', content: 'Goal' }],
      planner: [
        {
          kind: 'content',
          content: JSON.stringify({
            plan: [{ name: 's1', instructions: 'do' }],
          }),
        },
      ],
      executor: [toolCall('ExtTool', { q: 'abc' })],
      isExternalTool: () => true,
    });
    const handler = new ControllerCoordinatorHandler(h.deps);
    const { ctx, captured } = fakeCtx();

    const ret = await handler.execute(ctx, {}, undefined);

    assert.equal(ret, true);
    const surfaced = captured.find(
      (c) =>
        c.ok &&
        c.value.finishReason === 'tool_calls' &&
        (c.value.toolCalls?.length ?? 0) > 0,
    );
    assert.ok(surfaced, 'tool_calls chunk surfaced');
    const expectedExt = externalToolCallId('ExtTool', { q: 'abc' });
    const bundle = await hydrateBundle(h.backend, 'sess-1');
    assert.equal(bundle.pending?.kind, 'external-tool');
    assert.equal(
      bundle.pending?.kind === 'external-tool' ? bundle.pending.extId : '',
      expectedExt,
    );
  });

  it('resume external: pending resolved from externalResults → done', async () => {
    // First leg: suspend on the external tool.
    const h = harness({
      evaluator: [{ kind: 'content', content: 'Goal' }],
      planner: [
        {
          kind: 'content',
          content: JSON.stringify({
            plan: [{ name: 's1', instructions: 'do' }],
          }),
        },
      ],
      executor: [toolCall('ExtTool', { q: 'abc' })],
      isExternalTool: () => true,
    });
    const handler = new ControllerCoordinatorHandler(h.deps);
    await handler.execute(fakeCtx().ctx, {}, undefined);
    const extId = externalToolCallId('ExtTool', { q: 'abc' });

    // Second leg: planner finalizes; provide the external result.
    // Under plan-first the finalize call returns PLAIN TEXT (not JSON done).
    (h.deps.planner as ISubagentClient & { send: unknown }).send = async () =>
      ({ kind: 'content', content: 'resumed-done' }) as SubagentResult;
    const { ctx, captured } = fakeCtx({
      externalResults: new Map([[extId, 'TOOL RESULT']]),
    });

    const ret = await handler.execute(ctx, {}, undefined);

    assert.equal(ret, true);
    assert.ok(
      captured.find(
        (c) =>
          c.ok &&
          c.value.finishReason === 'stop' &&
          c.value.content === 'resumed-done',
      ),
    );
    const bundle = await hydrateBundle(h.backend, 'sess-1');
    assert.equal(bundle.pending, undefined);
  });

  it('rewind: one rewind then proceeds to done', async () => {
    // SmartExecutorPlanner cannot emit {kind:'rewind'} — use the DI seam to inject
    // a fake IControllerPlanner that emits rewind once, then next+done.
    const rewindPlan: NextStep[] = [
      { kind: 'rewind', reason: 'wrong path' },
      { kind: 'next', step: { name: 's1', instructions: 'do' } },
      { kind: 'done', result: 'ok' },
    ];
    const fakePlanner: IControllerPlanner = {
      async next() {
        return rewindPlan.shift() ?? null;
      },
      commit(_bundle: SessionBundle) {},
    };
    const h = harness({
      evaluator: [{ kind: 'content', content: 'Goal' }],
      planner: [],
      executor: [{ kind: 'content', content: 'x' }],
    });
    h.deps.controllerPlanner = fakePlanner;
    const handler = new ControllerCoordinatorHandler(h.deps);
    const { ctx, captured } = fakeCtx();

    const ret = await handler.execute(ctx, {}, undefined);

    assert.equal(ret, true);
    assert.ok(
      captured.find(
        (c) =>
          c.ok && c.value.finishReason === 'stop' && c.value.content === 'ok',
      ),
    );
    const bundle = await hydrateBundle(h.backend, 'sess-1');
    assert.equal(bundle.budgets.rewindsUsed, 1);
  });

  it('rewind budget: escalates after exceeding maxRewinds', async () => {
    // SmartExecutorPlanner cannot emit {kind:'rewind'} — use the DI seam to inject
    // a fake IControllerPlanner that emits two rewinds (exceeding maxRewinds=1).
    const rewindPlan: NextStep[] = [
      { kind: 'rewind', reason: 'a' },
      { kind: 'rewind', reason: 'b' },
    ];
    const fakePlanner: IControllerPlanner = {
      async next() {
        return rewindPlan.shift() ?? null;
      },
      commit(_bundle: SessionBundle) {},
    };
    const h = harness({
      evaluator: [{ kind: 'content', content: 'Goal' }],
      planner: [],
      executor: [],
      config: baseConfig({ maxRewinds: 1 }),
    });
    h.deps.controllerPlanner = fakePlanner;
    const handler = new ControllerCoordinatorHandler(h.deps);
    const { ctx, captured } = fakeCtx();

    const ret = await handler.execute(ctx, {}, undefined);

    assert.equal(ret, true);
    // Escalation = clarify surfaced (content + terminal stop).
    assert.ok(
      captured.find((c) => c.ok && /rewind/i.test(c.value.content)),
      'a clarify mentioning rewinds was surfaced',
    );
    const bundle = await hydrateBundle(h.backend, 'sess-1');
    assert.equal(bundle.pending?.kind, 'clarify');
  });

  it('step budget: escalates after maxSteps reached', async () => {
    const h = harness({
      evaluator: [{ kind: 'content', content: 'Goal' }],
      planner: [
        // plan-first: create a 2-step plan; after s1 the step budget (maxSteps=1) is hit
        {
          kind: 'content',
          content: JSON.stringify({
            plan: [
              { name: 's1', instructions: 'd' },
              { name: 's2', instructions: 'd' },
            ],
          }),
        },
      ],
      executor: [
        { kind: 'content', content: 'r1' },
        { kind: 'content', content: 'r2' },
      ],
      config: baseConfig({ maxSteps: 1 }),
    });
    const handler = new ControllerCoordinatorHandler(h.deps);
    const { ctx, captured } = fakeCtx();

    const ret = await handler.execute(ctx, {}, undefined);

    assert.equal(ret, true);
    assert.ok(
      captured.find((c) => c.ok && /budget/i.test(c.value.content)),
      'a clarify mentioning budget was surfaced',
    );
    const bundle = await hydrateBundle(h.backend, 'sess-1');
    assert.equal(bundle.pending?.kind, 'clarify');
  });

  it('error → retry exhausted → replan reaches done', async () => {
    const h = harness({
      evaluator: [{ kind: 'content', content: 'Goal' }],
      planner: [
        // create-plan: one step
        {
          kind: 'content',
          content: JSON.stringify({
            plan: [{ name: 's1', instructions: 'do' }],
          }),
        },
        // replan after s1 exhausts retries: empty plan → proceeds to finalize
        {
          kind: 'content',
          content: JSON.stringify({ plan: [] }),
        },
        // finalize: plain text
        { kind: 'content', content: 'replanned-done' },
      ],
      // maxRetries = 2 → executor must fail (maxRetries + 1) = 3 times.
      executor: [
        { kind: 'error', error: 'boom' },
        { kind: 'error', error: 'boom' },
        { kind: 'error', error: 'boom' },
      ],
      config: baseConfig({ maxRetries: 2 }),
    });
    const handler = new ControllerCoordinatorHandler(h.deps);
    const { ctx, captured } = fakeCtx();

    const ret = await handler.execute(ctx, {}, undefined);

    assert.equal(ret, true);
    const bundle = await hydrateBundle(h.backend, 'sess-1');
    assert.equal(bundle.budgets.stepsUsed, 1, 'failed step counted once');
    assert.ok(
      /failed|aborted/.test(bundle.plannerPrivate),
      'plannerPrivate has a failed/aborted note',
    );
    assert.ok(
      captured.find(
        (c) =>
          c.ok &&
          c.value.finishReason === 'stop' &&
          c.value.content === 'replanned-done',
      ),
      'loop replanned and reached done',
    );
  });

  it('internal tool-call budget: aborts step after maxToolCalls and run completes', async () => {
    const h = harness({
      evaluator: [{ kind: 'content', content: 'Goal' }],
      planner: [
        // create-plan: one step
        {
          kind: 'content',
          content: JSON.stringify({
            plan: [{ name: 's1', instructions: 'do' }],
          }),
        },
        // replan after the step aborts on tool-call budget: empty plan → finalize
        {
          kind: 'content',
          content: JSON.stringify({ plan: [] }),
        },
        // finalize: plain text
        { kind: 'content', content: 'budget-done' },
      ],
      // Executor ALWAYS emits an internal tool call → would loop forever
      // without the bound.
      executor: Array.from({ length: 50 }, () => toolCall('LoopTool', {})),
      selectTools: [{ name: 'LoopTool', description: '', inputSchema: {} }],
      isExternalTool: () => false,
      callMcpReturns: 'mcp-out',
      config: baseConfig({ maxToolCalls: 2 }),
    });
    const handler = new ControllerCoordinatorHandler(h.deps);
    const { ctx, captured } = fakeCtx();

    const ret = await handler.execute(ctx, {}, undefined);

    assert.equal(ret, true);
    assert.ok(
      h.mcpCalls.length <= 2,
      `callMcp invoked at most maxToolCalls times (got ${h.mcpCalls.length})`,
    );
    const bundle = await hydrateBundle(h.backend, 'sess-1');
    assert.equal(bundle.budgets.stepsUsed, 1, 'aborted step advanced');
    assert.ok(
      /tool-call budget/.test(bundle.plannerPrivate),
      'plannerPrivate has a tool-call budget note',
    );
    assert.ok(
      captured.find(
        (c) =>
          c.ok &&
          c.value.finishReason === 'stop' &&
          c.value.content === 'budget-done',
      ),
      'run completed without hanging',
    );
  });

  it('I2: routes external via per-request ctx.externalTools when deps.isExternalTool is undefined', async () => {
    const h = harness({
      evaluator: [{ kind: 'content', content: 'Goal' }],
      planner: [
        {
          kind: 'content',
          content: JSON.stringify({
            plan: [{ name: 's1', instructions: 'do' }],
          }),
        },
      ],
      executor: [toolCall('ExtTool', { q: 'abc' })],
      // NOTE: no isExternalTool override — routing must come from ctx.externalTools.
    });
    assert.equal(
      h.deps.isExternalTool,
      undefined,
      'deps.isExternalTool is undefined in this case',
    );
    const handler = new ControllerCoordinatorHandler(h.deps);
    const { ctx, captured } = fakeCtx({
      externalTools: [{ name: 'ExtTool' }] as never,
    });

    const ret = await handler.execute(ctx, {}, undefined);

    assert.equal(ret, true);
    const surfaced = captured.find(
      (c) =>
        c.ok &&
        c.value.finishReason === 'tool_calls' &&
        (c.value.toolCalls?.length ?? 0) > 0,
    );
    assert.ok(surfaced, 'tool_calls chunk surfaced via per-request routing');
    const bundle = await hydrateBundle(h.backend, 'sess-1');
    assert.equal(bundle.pending?.kind, 'external-tool');
    assert.equal(
      bundle.pending?.kind === 'external-tool' ? bundle.pending.toolName : '',
      'ExtTool',
    );
  });

  it('I1: recalled session-memory artifacts are injected into the executor messages', async () => {
    const seenMessages: Message[][] = [];
    const capturingExecutor: ISubagentClient & { calls: number } = {
      get calls() {
        return seenMessages.length;
      },
      async send(messages: Message[]) {
        seenMessages.push(messages);
        return { kind: 'content', content: 'did s1' } as SubagentResult;
      },
    };
    const ragQuery: IKnowledgeRagHandle['query'] = async (_text, opts) => {
      // Recall must restrict to recall artifact types (excludes 'controller-bundle').
      // The recall issues per-kind queries (step-result for the static prefix, plus
      // per-`requires` evidence queries); every query's filter must be a subset of
      // the recall artifact types.
      const types = (opts?.filter?.artifactType ?? []) as string[];
      assert.ok(
        types.length > 0 &&
          types.every((t) => ['step-result', 'mcp-result'].includes(t)),
        'recall restricts to recall artifact types',
      );
      // NOTE (Task 11): the STEP-RESULT recall stays in the executor's static
      // prefix; the mcp-result recall moved to the injected context strategy. So the
      // step-result recall is what gets injected into the executor messages here.
      if (!types.includes('step-result')) return [];
      return [
        {
          content: 'INCLUDE zinc.',
          metadata: {
            traceId: 't',
            turnId: 't',
            stepperId: 'controller',
            task: 'ZINC',
            artifactType: 'step-result',
            createdAt: '2026-06-06T00:00:00.000Z',
          },
        },
      ];
    };
    const h = harness({
      evaluator: [{ kind: 'content', content: 'Goal' }],
      planner: [
        {
          kind: 'content',
          content: JSON.stringify({
            plan: [{ name: 's1', instructions: 'find includes' }],
          }),
        },
        { kind: 'content', content: 'done' },
      ],
      executor: [],
      ragQuery,
    });
    h.deps.executor = capturingExecutor;
    const handler = new ControllerCoordinatorHandler(h.deps);
    const { ctx } = fakeCtx();

    const ret = await handler.execute(ctx, {}, undefined);

    assert.equal(ret, true);
    assert.ok(seenMessages.length >= 1, 'executor was called');
    const injected = seenMessages[0].some(
      (m) =>
        typeof m.content === 'string' &&
        m.content.includes('Relevant prior context') &&
        m.content.includes('INCLUDE zinc.'),
    );
    assert.ok(injected, 'recalled content injected into executor messages');
  });

  it('I3: surfaces toolsRag-selected tools to the executor; routes the call via callMcp and feeds back a role:tool message', async () => {
    const readTable: LlmTool = {
      name: 'ReadTable',
      description: 'Read a DB table',
      inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
    };
    // Capture every (messages, tools) pair the executor is sent.
    const sends: Array<{ messages: Message[]; tools?: LlmTool[] }> = [];
    const executorQueue: SubagentResult[] = [
      toolCall('ReadTable', { name: 'SCARR' }),
      { kind: 'content', content: 'read it' },
    ];
    const capturingExecutor: ISubagentClient = {
      async send(messages: Message[], tools?: LlmTool[]) {
        sends.push({ messages, tools });
        return (
          executorQueue.shift() ?? ({ kind: 'content', content: '' } as const)
        );
      },
    };
    const h = harness({
      evaluator: [{ kind: 'content', content: 'Goal' }],
      planner: [
        {
          kind: 'content',
          content: JSON.stringify({
            plan: [{ name: 's1', instructions: 'read the table' }],
          }),
        },
        { kind: 'content', content: 'internal-done' },
      ],
      executor: [],
      selectTools: [readTable],
      // ReadTable is internal → must NOT be treated as external.
      isExternalTool: () => false,
      callMcpReturns: 'TABLE ROWS',
    });
    h.deps.executor = capturingExecutor;
    const handler = new ControllerCoordinatorHandler(h.deps);
    const { ctx, captured } = fakeCtx();

    const ret = await handler.execute(ctx, {}, undefined);

    assert.equal(ret, true);
    // The executor was offered the toolsRag-selected tool on its first send.
    assert.ok(sends.length >= 1, 'executor was sent at least once');
    assert.ok(
      sends[0].tools?.some((t) => t.name === 'ReadTable'),
      'executor offered the toolsRag-selected ReadTable tool',
    );
    // The internal call routed through callMcp.
    assert.equal(h.mcpCalls.length, 1, 'callMcp fired once');
    assert.equal(h.mcpCalls[0].name, 'ReadTable');
    // The result was fed back as a proper role:'tool' message on the re-send.
    assert.ok(sends.length >= 2, 'executor was re-sent after the tool call');
    const toolMsg = sends[1].messages.find((m) => m.role === 'tool');
    assert.ok(toolMsg, 'a role:tool message carries the result');
    assert.equal(toolMsg?.content, 'TABLE ROWS');
    assert.ok(
      sends[1].messages.some(
        (m) => m.role === 'assistant' && (m.tool_calls?.length ?? 0) > 0,
      ),
      'the assistant tool_call turn precedes the tool result',
    );
    assert.ok(
      captured.find(
        (c) =>
          c.ok &&
          c.value.finishReason === 'stop' &&
          c.value.content === 'internal-done',
      ),
      'run reached done',
    );
  });

  it('goal clarify: orthogonal embedding → escalate + persist clarify pending', async () => {
    let n = 0;
    const orthoEmbedder = {
      embed: async () => ({ vector: n++ === 0 ? [1, 0] : [0, 1] }),
    } as never;
    const h = harness({
      evaluator: [{ kind: 'content', content: 'Goal: X' }],
      planner: [],
      executor: [],
      embedder: orthoEmbedder,
      config: {
        ...baseConfig(),
        targetState: { strategy: 'semantic-distance', distanceThreshold: 0.1 },
      },
    });
    const handler = new ControllerCoordinatorHandler(h.deps);
    const { ctx, captured } = fakeCtx();

    const ret = await handler.execute(ctx, {}, undefined);

    assert.equal(ret, true);
    const bundle = await hydrateBundle(h.backend, 'sess-1');
    assert.equal(bundle.pending?.kind, 'clarify');
    assert.ok(
      captured.find((c) => c.ok && c.value.finishReason === 'stop'),
      'terminal stop after clarify surfaced',
    );
  });

  it('consumer-confirm: goal-clarify resume commits the answer as goal (no confirm loop)', async () => {
    const backend = new InMemoryKnowledgeBackend();
    const cfg: ControllerConfig = {
      ...baseConfig(),
      targetState: { strategy: 'consumer-confirm', distanceThreshold: 0.25 },
    };

    // Leg 1: first request → evaluator formulates, consumer-confirm escalates.
    const h1 = harness({
      evaluator: [{ kind: 'content', content: 'Goal: read T100' }],
      planner: [],
      executor: [],
      config: cfg,
    });
    h1.deps.backend = backend;
    const handler1 = new ControllerCoordinatorHandler(h1.deps);
    const r1 = await handler1.execute(
      fakeCtx({ textOrMessages: 'read T100' }).ctx,
      {},
      undefined,
    );
    assert.equal(r1, true);
    let bundle = await hydrateBundle(backend, 'sess-1');
    assert.equal(bundle.pending?.kind, 'clarify');
    assert.equal(
      bundle.pending?.kind === 'clarify' && bundle.pending.position,
      'goal',
    );
    assert.equal(
      bundle.pending?.kind === 'clarify' && bundle.pending.proposedTarget,
      'Goal: read T100',
      'proposed target persisted on the pending marker',
    );
    assert.equal(bundle.goal, '', 'goal not yet committed on leg 1');

    // Leg 2: a REFINEMENT answer (not an affirmation) becomes the goal verbatim,
    // and the loop proceeds to done WITHOUT re-invoking the evaluator.
    const h2 = harness({
      evaluator: [], // must NOT be called
      planner: [
        // create-plan: one step (empty plan is rejected by the plan-first engine
        // as a format error — a real task always has at least one step)
        {
          kind: 'content',
          content: JSON.stringify({
            plan: [{ name: 's1', instructions: 'execute the read' }],
          }),
        },
        // finalize: plain text
        { kind: 'content', content: 'all done' },
      ],
      executor: [{ kind: 'content', content: 'read done' }],
      config: cfg,
    });
    h2.deps.backend = backend;
    const handler2 = new ControllerCoordinatorHandler(h2.deps);
    const { ctx, captured } = fakeCtx({
      textOrMessages: 'read structure of table T100',
      // Clarify-resume: the answer's fingerprint differs from the original
      // request, so the consumer echoes the runId token to resume the suspended
      // run (strict classification — token path, not fingerprint).
      options: { runId: bundle.runId } as never,
    });
    const r2 = await handler2.execute(ctx, {}, undefined);

    assert.equal(r2, true);
    bundle = await hydrateBundle(backend, 'sess-1');
    assert.equal(bundle.goal, 'read structure of table T100');
    assert.equal(bundle.pending, undefined);
    assert.equal(
      (h2.deps.evaluator as { calls: number }).calls,
      0,
      'evaluator was NOT re-invoked on resume (no confirm loop)',
    );
    assert.ok(
      captured.find(
        (c) =>
          c.ok &&
          c.value.finishReason === 'stop' &&
          c.value.content === 'all done',
      ),
      'run reached done after goal confirmation',
    );
  });

  it('consumer-confirm: a bare affirmation commits the PROPOSED target, not "yes"', async () => {
    const backend = new InMemoryKnowledgeBackend();
    const cfg: ControllerConfig = {
      ...baseConfig(),
      targetState: { strategy: 'consumer-confirm', distanceThreshold: 0.25 },
    };

    // Leg 1: evaluator proposes a target; consumer-confirm escalates.
    const h1 = harness({
      evaluator: [{ kind: 'content', content: 'Goal: read T100 structure' }],
      planner: [],
      executor: [],
      config: cfg,
    });
    h1.deps.backend = backend;
    await new ControllerCoordinatorHandler(h1.deps).execute(
      fakeCtx({ textOrMessages: 'read T100' }).ctx,
      {},
      undefined,
    );

    // Leg 2: the human confirms with a bare "yes" → goal = the PROPOSED target.
    // The bare "yes" does not fingerprint-match the original request, so the
    // consumer echoes the runId token to resume the suspended run.
    const b1 = await hydrateBundle(backend, 'sess-1');
    const h2 = harness({
      evaluator: [],
      planner: [
        // create-plan: one step (empty plan is rejected by the plan-first engine)
        {
          kind: 'content',
          content: JSON.stringify({
            plan: [{ name: 's1', instructions: 'execute the read' }],
          }),
        },
        // finalize: plain text
        { kind: 'content', content: 'ok' },
      ],
      executor: [{ kind: 'content', content: 'read done' }],
      config: cfg,
    });
    h2.deps.backend = backend;
    await new ControllerCoordinatorHandler(h2.deps).execute(
      fakeCtx({ textOrMessages: 'yes', options: { runId: b1.runId } as never })
        .ctx,
      {},
      undefined,
    );

    const bundle = await hydrateBundle(backend, 'sess-1');
    assert.equal(
      bundle.goal,
      'Goal: read T100 structure',
      'affirmation commits the proposed target, not the literal "yes"',
    );
    assert.equal(bundle.pending, undefined);
  });

  it('rejects a tool the executor was NOT offered (no callMcp; fed back as not-available)', async () => {
    const allowed: LlmTool = {
      name: 'AllowedTool',
      description: 'ok',
      inputSchema: { type: 'object' },
    };
    const sends: Array<{ messages: Message[]; tools?: LlmTool[] }> = [];
    const executorQueue: SubagentResult[] = [
      toolCall('ForbiddenTool', { x: 1 }), // not in selectTools, not external
      toolCall('ForbiddenTool', { x: 1 }), // keeps trying → exhausts retries
      { kind: 'content', content: 'fell back to text' },
    ];
    const capturingExecutor: ISubagentClient = {
      async send(messages: Message[], tools?: LlmTool[]) {
        sends.push({ messages, tools });
        return (
          executorQueue.shift() ?? ({ kind: 'content', content: '' } as const)
        );
      },
    };
    const h = harness({
      evaluator: [{ kind: 'content', content: 'Goal' }],
      planner: [
        {
          kind: 'content',
          content: JSON.stringify({
            plan: [{ name: 's1', instructions: 'do' }],
          }),
        },
        // replan after the ForbiddenTool retry exhaustion
        {
          kind: 'content',
          content: JSON.stringify({ plan: [] }),
        },
        // finalize
        { kind: 'content', content: 'done' },
      ],
      executor: [],
      selectTools: [allowed], // only AllowedTool is offered
      isExternalTool: () => false,
      config: baseConfig({ maxRetries: 1 }),
    });
    h.deps.executor = capturingExecutor;
    const ret = await new ControllerCoordinatorHandler(h.deps).execute(
      fakeCtx().ctx,
      {},
      undefined,
    );

    assert.equal(ret, true);
    assert.equal(
      h.mcpCalls.length,
      0,
      'the non-offered tool was NEVER executed',
    );
    assert.ok(
      sends.some((s) =>
        s.messages.some(
          (m) =>
            typeof m.content === 'string' && /not available/i.test(m.content),
        ),
      ),
      'executor was told the tool is not available',
    );
  });

  it('parses planner JSON wrapped in a ```json fence / prose (no spurious rewind)', async () => {
    const h = harness({
      evaluator: [{ kind: 'content', content: 'Goal' }],
      planner: [
        // fenced JSON plan-first create-plan: parsePlan must unwrap the fence
        {
          kind: 'content',
          content: '```json\n{"plan":[{"name":"s1","instructions":"do"}]}\n```',
        },
        // prose-wrapped finalize: plain text (not JSON) → done result
        {
          kind: 'content',
          content: 'finished',
        },
      ],
      executor: [{ kind: 'content', content: 'did it' }],
      selectTools: [],
    });
    const { ctx, captured } = fakeCtx();
    const ret = await new ControllerCoordinatorHandler(h.deps).execute(
      ctx,
      {},
      undefined,
    );

    assert.equal(ret, true);
    const bundle = await hydrateBundle(h.backend, 'sess-1');
    assert.equal(
      bundle.budgets.rewindsUsed,
      0,
      'fenced/prose JSON did NOT cause a rewind',
    );
    assert.equal(bundle.budgets.stepsUsed, 1);
    assert.ok(
      captured.find(
        (c) =>
          c.ok &&
          c.value.finishReason === 'stop' &&
          c.value.content === 'finished',
      ),
      'reached done from prose-wrapped JSON',
    );
  });

  it('unparsable planner output retries without burning the rewind budget, then escalates', async () => {
    const h = harness({
      evaluator: [{ kind: 'content', content: 'Goal' }],
      // Always pure prose — never valid NextStep JSON.
      planner: Array.from(
        { length: 10 },
        () =>
          ({
            kind: 'content',
            content: 'I think we should look into it.',
          }) as const,
      ),
      executor: [],
      selectTools: [],
      config: baseConfig({ maxRetries: 2 }),
    });
    const { ctx, captured } = fakeCtx();
    const ret = await new ControllerCoordinatorHandler(h.deps).execute(
      ctx,
      {},
      undefined,
    );

    assert.equal(ret, true);
    const bundle = await hydrateBundle(h.backend, 'sess-1');
    assert.equal(
      bundle.budgets.rewindsUsed,
      0,
      'parse failures did NOT consume the rewind budget',
    );
    assert.equal(bundle.pending?.kind, 'clarify');
    assert.ok(
      captured.find((c) => c.ok && c.value.finishReason === 'stop'),
      'escalated with a clarify after parse-retries',
    );
  });

  it('surfaces accumulated token usage on the clarify path (not only on done)', async () => {
    const h = harness({
      // evaluator reports usage; consumer-confirm → clarify before any planning.
      evaluator: [
        {
          kind: 'content',
          content: 'Goal: X',
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        },
      ],
      planner: [],
      executor: [],
      config: {
        ...baseConfig(),
        targetState: { strategy: 'consumer-confirm', distanceThreshold: 0.25 },
      },
    });
    const { ctx, captured } = fakeCtx();
    const ret = await new ControllerCoordinatorHandler(h.deps).execute(
      ctx,
      {},
      undefined,
    );

    assert.equal(ret, true);
    const term = captured.find((c) => c.ok && c.value.finishReason === 'stop');
    assert.ok(
      term?.ok && term.value.usage,
      'terminal clarify chunk carries usage (not zero/absent)',
    );
    assert.equal(term.ok && term.value.usage?.totalTokens, 15);
  });

  it('adaptive planner: create plan → run steps → finalize', async () => {
    const h = harness({
      evaluator: [{ kind: 'content', content: 'Goal: do it' }],
      // planner queue: (1) create-plan, (2) finalize
      planner: [
        {
          kind: 'content',
          content: JSON.stringify({
            plan: [{ name: 's1', instructions: 'fetch A' }],
          }),
        },
        { kind: 'content', content: 'FINAL' },
      ],
      executor: [{ kind: 'content', content: 'did s1' }],
      config: { ...baseConfig() },
    });
    const { ctx, captured } = fakeCtx();
    const ret = await new ControllerCoordinatorHandler(h.deps).execute(
      ctx,
      {},
      undefined,
    );

    assert.equal(ret, true);
    assert.ok(
      captured.find(
        (c) =>
          c.ok &&
          c.value.finishReason === 'stop' &&
          c.value.content === 'FINAL',
      ),
      'finalized result surfaced',
    );
    const bundle = await hydrateBundle(h.backend, 'sess-1');
    assert.equal(bundle.plan?.length, 1);
    assert.equal(bundle.budgets.stepsUsed, 1);
  });

  it('adaptive: a persisted cursor resumes from the NEXT step (no repeat)', async () => {
    const backend = new InMemoryKnowledgeBackend();
    const cfg: ControllerConfig = { ...baseConfig() };
    await persistBundle(backend, 'sess-1', {
      goal: 'Goal',
      plannerPrivate: '\n[step s1] did A',
      budgets: { stepsUsed: 1, rewindsUsed: 0 },
      plan: [
        { name: 's1', instructions: 'fetch A' },
        { name: 's2', instructions: 'fetch B' },
      ],
      planCursor: 1, // s1 already completed + persisted
      // Run-state so strict classification treats this turn as a resume of the
      // in-flight run (same default prompt 'do the thing'), not a fresh reset.
      runState: 'active',
      originalRequest: 'do the thing',
    } as never);
    const seen: string[] = [];
    const h = harness({
      evaluator: [], // goal already set → evaluator not called
      planner: [{ kind: 'content', content: 'FINAL' }], // finalize after s2
      executor: [],
      config: cfg,
    });
    h.deps.backend = backend;
    h.deps.executor = {
      async send(messages: Message[]) {
        const u = messages.find((m) => m.role === 'user');
        if (typeof u?.content === 'string') seen.push(u.content);
        return { kind: 'content', content: 'did it' };
      },
    };
    await new ControllerCoordinatorHandler(h.deps).execute(
      fakeCtx().ctx,
      {},
      undefined,
    );
    assert.ok(
      seen.some((c) => c.includes('fetch B')),
      'resumed at s2',
    );
    assert.ok(!seen.some((c) => c.includes('fetch A')), 's1 was NOT repeated');
  });

  it('adaptive + external tool: resume injects the result into the step transcript; the executor continues', async () => {
    const backend = new InMemoryKnowledgeBackend();
    const cfg: ControllerConfig = { ...baseConfig() };
    const extId = externalToolCallId('ExtTool', { q: 'x' });

    // Leg 1 — 1-step plan; executor emits an external tool call → suspend.
    const h1 = harness({
      evaluator: [{ kind: 'content', content: 'Goal' }],
      planner: [
        {
          kind: 'content',
          content: JSON.stringify({
            plan: [{ name: 's1', instructions: 'do' }],
          }),
        },
      ],
      executor: [toolCall('ExtTool', { q: 'x' })],
      config: cfg,
    });
    h1.deps.backend = backend;
    const { ctx: c1, captured: cap1 } = fakeCtx({
      externalTools: [{ name: 'ExtTool', description: '', inputSchema: {} }],
    });
    await new ControllerCoordinatorHandler(h1.deps).execute(c1, {}, undefined);
    let b = await hydrateBundle(backend, 'sess-1');
    assert.equal(b.pending?.kind, 'external-tool');
    assert.equal(b.planCursor, 0, 'cursor unmoved on suspend');
    assert.ok(cap1.find((c) => c.ok && c.value.finishReason === 'tool_calls'));

    // Leg 2 — resume with the result. The unified design injects the tool result
    // into the in-flight step's transcript and RE-RUNS the step (the executor
    // continues from its own tool call); the PLANNER is not consulted for the
    // continuation. The executor must therefore see TOOL RESULT in its messages;
    // once the step commits, the (1-step) plan is exhausted → finalize.
    const execSawResult: boolean[] = [];
    const h2 = harness({
      evaluator: [],
      planner: [{ kind: 'content', content: 'FINAL' }], // finalize after the step
      executor: [],
      config: cfg,
    });
    h2.deps.backend = backend;
    h2.deps.executor = {
      async send(messages: Message[]) {
        execSawResult.push(
          messages.some(
            (m) =>
              typeof m.content === 'string' &&
              m.content.includes('TOOL RESULT'),
          ),
        );
        return { kind: 'content', content: 'continued with the result' };
      },
    };
    const { ctx: c2, captured: cap2 } = fakeCtx({
      externalResults: new Map([[extId, 'TOOL RESULT']]),
    });
    const ret = await new ControllerCoordinatorHandler(h2.deps).execute(
      c2,
      {},
      undefined,
    );

    assert.equal(ret, true);
    b = await hydrateBundle(backend, 'sess-1');
    assert.equal(b.pending, undefined);
    assert.ok(
      execSawResult.some(Boolean),
      'the executor continued the step with the external tool result in its transcript',
    );
    assert.ok(
      cap2.find(
        (c) =>
          c.ok &&
          c.value.finishReason === 'stop' &&
          c.value.content === 'FINAL',
      ),
    );
  });

  it('external resume: an already-committed artifact at (runId,seq,attempt) is adopted (no re-call)', async () => {
    const backend = new InMemoryKnowledgeBackend();
    const extId = externalToolCallId('ExtTool', { q: 'x' });
    // Bundle suspended on ExtTool at seq 0 attempt 0, AND a committed ok artifact
    // already exists for that identity (a crash after the step finished, before the
    // bundle flip). Resume must ADOPT it, not re-run the step or re-call the tool.
    await persistBundle(backend, 'sess-1', {
      goal: 'g',
      plannerPrivate: '',
      budgets: { stepsUsed: 0, rewindsUsed: 0 },
      runId: 'R1',
      runState: 'suspended',
      runPhase: 'executing',
      originalRequest: 'x',
      nextSeq: 0,
      // Plan must be seeded so that after adopting s1 the planner sees the plan
      // is exhausted and calls FINALIZE_SYSTEM (not CREATE_PLAN again).
      plan: [{ name: 's1', instructions: 'i' }],
      planCursor: 0,
      inFlightStep: {
        seq: 0,
        step: { name: 's1', instructions: 'i' },
        attempt: 0,
        resumeCount: 0,
        phase: 'executing',
        transcript: [],
        toolCallCount: 1,
      },
      pending: {
        kind: 'external-tool',
        extId,
        toolName: 'ExtTool',
        args: { q: 'x' },
        position: 's1',
      },
    } as never);
    // A rag whose list() actually filters the written entries (the default stub
    // returns [], which would make the artifact-first adopt vacuously fall through).
    const written: KnowledgeEntry[] = [];
    const rag: IKnowledgeRagHandle & { written: KnowledgeEntry[] } = {
      written,
      query: async () => [],
      async list(filter) {
        return written.filter(
          (e) =>
            (filter.runId === undefined || e.metadata.runId === filter.runId) &&
            (filter.seq === undefined || e.metadata.seq === filter.seq) &&
            (filter.attempt === undefined ||
              e.metadata.attempt === filter.attempt) &&
            (filter.artifactType === undefined ||
              e.metadata.artifactType === filter.artifactType),
        );
      },
      async write(e) {
        written.push(e);
      },
      fingerprint() {
        return 'stub';
      },
    };
    await rag.write({
      content: 'DONE',
      metadata: {
        traceId: 't',
        turnId: 't',
        stepperId: 'controller',
        task: 's1',
        artifactType: 'step-result',
        createdAt: '2026-06-10T00:00:00.000Z',
        runId: 'R1',
        seq: 0,
        attempt: 0,
        status: 'ok',
      },
    });
    const h = harness({
      evaluator: [],
      planner: [
        // finalize: plain text (the step was adopted; plan exhausted → finalize)
        { kind: 'content', content: 'fin' },
      ],
      executor: [],
    });
    h.deps.backend = backend;
    h.deps.knowledgeRagFor = () => rag;
    // Prompt fingerprint matches the seeded originalRequest so the turn classifies
    // as a resume (not a fresh reset).
    const { ctx } = fakeCtx({
      textOrMessages: 'x',
      externalResults: new Map([[extId, 'LATE RESULT']]),
    });
    await new ControllerCoordinatorHandler(h.deps).execute(ctx, {}, undefined);
    const b = await hydrateBundle(backend, 'sess-1');
    assert.equal(b.pending, undefined, 'pending cleared (adopted, not re-run)');
    assert.equal(b.nextSeq, 1, 'advanced past the adopted seq');
    assert.equal(
      (h.deps.executor as { calls: number }).calls,
      0,
      'executor was NOT re-run — the committed artifact was adopted',
    );
  });

  it('legacy external resume (no inFlightStep): feeds plannerPrivate + replan, parse-retry preserves resumedExternal', async () => {
    const backend = new InMemoryKnowledgeBackend();
    const cfg: ControllerConfig = { ...baseConfig() };
    const extId = externalToolCallId('ExtTool', { q: 'x' });
    // Seed a SUSPENDED adaptive bundle WITHOUT an inFlightStep — the retained
    // legacy external-resume branch: the result is fed via plannerPrivate and the
    // planner replans (the unified continue-the-step path requires an inFlightStep).
    await persistBundle(backend, 'sess-1', {
      goal: 'Goal',
      plannerPrivate: '',
      budgets: { stepsUsed: 0, rewindsUsed: 0 },
      runId: 'R1',
      runState: 'suspended',
      runPhase: 'planning',
      originalRequest: 'do the thing',
      nextSeq: 0,
      plan: [{ name: 's1', instructions: 'do' }],
      planCursor: 0,
      pending: {
        kind: 'external-tool',
        extId,
        toolName: 'ExtTool',
        args: { q: 'x' },
        position: 's1',
      },
    } as never);

    // Leg 2 — first replan reply malformed → parse-retry (resumedExternal must
    // survive) → second replan valid {plan:[]} → finalize. Capture replan prompts
    // (those whose system text is the external-result prompt) + executor calls.
    const replanSawResult: boolean[] = [];
    const execCalls: string[] = [];
    let n = 0;
    const h2 = harness({
      evaluator: [],
      planner: [],
      executor: [],
      config: cfg,
    });
    h2.deps.backend = backend;
    h2.deps.planner = {
      async send(messages: Message[]) {
        const sys = messages.find((m) => m.role === 'system');
        const usr = messages.find((m) => m.role === 'user');
        if (
          typeof sys?.content === 'string' &&
          /external tool result/i.test(sys.content)
        ) {
          replanSawResult.push(
            typeof usr?.content === 'string' &&
              usr.content.includes('TOOL RESULT'),
          );
        }
        const call = n++;
        if (call === 0) return { kind: 'content', content: 'not json at all' }; // malformed
        if (call === 1)
          return { kind: 'content', content: JSON.stringify({ plan: [] }) }; // valid replan
        return { kind: 'content', content: 'FINAL' }; // finalize
      },
    };
    h2.deps.executor = {
      async send(messages: Message[]) {
        const u = messages.find((m) => m.role === 'user');
        if (typeof u?.content === 'string') execCalls.push(u.content);
        return { kind: 'content', content: 'x' };
      },
    };
    const { ctx, captured } = fakeCtx({
      externalResults: new Map([[extId, 'TOOL RESULT']]),
    });
    const ret = await new ControllerCoordinatorHandler(h2.deps).execute(
      ctx,
      {},
      undefined,
    );

    assert.equal(ret, true);
    // BOTH the malformed and the valid replan ran via the external-result prompt
    // (proving resumedExternal survived the parse-retry), each seeing the result.
    assert.equal(
      replanSawResult.length,
      2,
      'replan was retried, not abandoned',
    );
    assert.ok(replanSawResult.every(Boolean), 'each replan saw TOOL RESULT');
    assert.equal(execCalls.length, 0, 'suspended step was NOT blindly re-run');
    assert.ok(
      captured.find(
        (c) =>
          c.ok &&
          c.value.finishReason === 'stop' &&
          c.value.content === 'FINAL',
      ),
    );
  });

  it('reviewer verdict (not the executor) decides the outcome', async () => {
    const h = harness({
      evaluator: [{ kind: 'content', content: 'Goal' }],
      planner: [
        {
          kind: 'content',
          content: JSON.stringify({
            plan: [{ name: 's1', instructions: 'do' }],
          }),
        },
        // replan after reviewer marks s1 failed
        {
          kind: 'content',
          content: JSON.stringify({ plan: [] }),
        },
        // finalize
        { kind: 'content', content: 'final' },
      ],
      executor: [{ kind: 'content', content: 'I think it worked' }],
    });
    // COORDINATOR OVERRIDE: IReviewer.review MUST return a ReviewResult, not a bare
    // Outcome. The plan text shows a bare object; use the discriminated form:
    h.deps.reviewer = {
      async review() {
        return {
          kind: 'outcome',
          outcome: {
            status: 'failed',
            approved: '',
            remainder: 'all',
            note: 'not done',
          },
        };
      },
    };
    const handler = new ControllerCoordinatorHandler(h.deps);
    const { ctx } = fakeCtx();
    await handler.execute(ctx, {}, undefined);
    const stepArtifact = h.rag.written.find(
      (e) => e.metadata.artifactType === 'step-result',
    );
    assert.equal(stepArtifact?.metadata.status, 'failed');
  });

  it('a persistent judge-failure is re-asked then DEGRADES to a failed step (replan), not a terminal abort', async () => {
    const h = harness({
      evaluator: [{ kind: 'content', content: 'Goal' }],
      planner: [
        {
          kind: 'content',
          content: JSON.stringify({
            plan: [{ name: 's1', instructions: 'do' }],
          }),
        },
        // replan after reviewer degrades to failed step
        {
          kind: 'content',
          content: JSON.stringify({ plan: [] }),
        },
        // finalize
        { kind: 'content', content: 'replanned-done' },
      ],
      executor: [{ kind: 'content', content: 'result' }],
      config: baseConfig({ maxReviewRetries: 1 }),
    });
    let reviewCalls = 0;
    h.deps.reviewer = {
      async review() {
        reviewCalls++;
        return { kind: 'judge-failure', reason: 'provider down' };
      },
    };
    const handler = new ControllerCoordinatorHandler(h.deps);
    const { ctx, captured } = fakeCtx();
    await handler.execute(ctx, {}, undefined);
    // initial review + 1 retry (maxReviewRetries=1), then degrade — NOT unbounded.
    assert.equal(reviewCalls, 2, 're-asked once then degraded (bounded)');
    // The step failed → the planner replanned → reached its done. NO terminal error.
    assert.ok(
      captured.find(
        (c) =>
          c.ok &&
          c.value.finishReason === 'stop' &&
          c.value.content === 'replanned-done',
      ),
      'the run replanned to done instead of aborting',
    );
    assert.ok(
      !captured.find(
        (c) => c.ok && /unverifiable|Error:/i.test(c.value.content),
      ),
      'no terminal error surfaced',
    );
    const bundle = await hydrateBundle(h.backend, 'sess-1');
    assert.equal(bundle.runState, 'terminal');
    const { readTerminal } = await import('../run-scope.js');
    const term = await readTerminal(
      h.backend,
      'sess-1',
      bundle.runId!,
      new Date().toISOString(),
    );
    assert.equal(
      term?.kind,
      'success',
      'terminal SUCCESS (finalized), not error',
    );
  });

  it('maxToolCalls is bounded by the durable toolCallCount, and abort is a controlFailure replan', async () => {
    const h = harness({
      evaluator: [{ kind: 'content', content: 'Goal' }],
      planner: [
        {
          kind: 'content',
          content: JSON.stringify({
            plan: [{ name: 's1', instructions: 'do' }],
          }),
        },
        // replan after tool-call budget abort
        {
          kind: 'content',
          content: JSON.stringify({ plan: [] }),
        },
        // finalize
        { kind: 'content', content: 'after-budget' },
      ],
      executor: Array.from({ length: 20 }, () => toolCall('LoopTool', {})),
      selectTools: [{ name: 'LoopTool', description: '', inputSchema: {} }],
      isExternalTool: () => false,
      config: baseConfig({ maxToolCalls: 2 }),
    });
    const handler = new ControllerCoordinatorHandler(h.deps);
    const { ctx } = fakeCtx();
    await handler.execute(ctx, {}, undefined);
    assert.ok(h.mcpCalls.length <= 2, 'callMcp bounded by maxToolCalls');
    const bundle = await hydrateBundle(h.backend, 'sess-1');
    assert.equal(bundle.budgets.stepsUsed, 1);
  });

  it('maxStepResumes: a crash-replay with no committed artifact charges resumeCount and aborts at the cap', async () => {
    const backend = new InMemoryKnowledgeBackend();
    // Seed an executing inFlightStep at resumeCount === cap, no committed artifact.
    await persistBundle(backend, 'sess-1', {
      goal: 'g',
      plannerPrivate: '',
      budgets: { stepsUsed: 0, rewindsUsed: 0 },
      runId: 'R1',
      runState: 'active',
      runPhase: 'executing',
      originalRequest: 'x',
      nextSeq: 0,
      inFlightStep: {
        seq: 0,
        step: { name: 's1', instructions: 'i' },
        attempt: 0,
        resumeCount: 1,
        phase: 'executing',
        transcript: [],
        toolCallCount: 0,
      },
      plan: [{ name: 's1', instructions: 'i' }],
      planCursor: 0,
    } as never);
    let plannerCalls = 0;
    const h = harness({
      evaluator: [],
      executor: [{ kind: 'content', content: 'x' }],
      planner: [],
      config: {
        ...baseConfig(),
        budgets: { ...baseConfig().budgets, maxStepResumes: 1 },
      },
    });
    h.deps.backend = backend;
    // The executing-recovery is planner-INDEPENDENT: the in-flight step is
    // reconciled/aborted DIRECTLY, the planner must NOT be consulted for it.
    h.deps.planner = {
      async send() {
        plannerCalls++;
        return {
          kind: 'content',
          content: JSON.stringify({ kind: 'done', result: 'should-not-run' }),
        };
      },
    };
    const { ctx, captured } = fakeCtx({ textOrMessages: 'x' });
    await new ControllerCoordinatorHandler(h.deps).execute(ctx, {}, undefined);
    const bundle = await hydrateBundle(backend, 'sess-1');
    assert.equal(bundle.runState, 'terminal', 'aborted at maxStepResumes');
    assert.equal(
      plannerCalls,
      0,
      'planner was NOT consulted for the in-flight executing step',
    );
    assert.ok(
      captured.find(
        (c) => c.ok && /maxStepResumes|Error:/.test(c.value.content),
      ),
    );
  });

  it('adaptive resume after a FAILED step REPLANS (durable lastOutcome) — not repeat', async () => {
    const h = harness({
      evaluator: [], // goal already in the seeded bundle → establishTargetState skipped
      planner: [],
      executor: [{ kind: 'content', content: 's2 done' }],
      config: { ...baseConfig() },
    });
    // Recording planner: capture the SYSTEM prompt of each call; reply replan→finalize.
    const seenSystems: string[] = [];
    const replies: SubagentResult[] = [
      {
        kind: 'content',
        content: JSON.stringify({
          plan: [{ name: 's2', instructions: 'fetch' }],
        }),
      },
      { kind: 'content', content: 'FINAL ANSWER' },
    ];
    h.deps.planner = {
      async send(messages) {
        seenSystems.push(
          typeof messages[0]?.content === 'string' ? messages[0].content : '',
        );
        return replies.shift() ?? { kind: 'content', content: '' };
      },
    };
    // Durable bundle: a step s1 FAILED, plan=[s1], cursor=0, lastOutcome='failed'.
    await persistBundle(h.backend, 'sess-1', {
      goal: 'do the thing',
      plannerPrivate: '\n[step s1 failed] boom',
      budgets: { stepsUsed: 1, rewindsUsed: 0 },
      plan: [{ name: 's1', instructions: 'orig' }],
      planCursor: 0,
      lastOutcome: 'failed',
      // Run-state so strict classification resumes this run (same default prompt).
      runState: 'active',
      originalRequest: 'do the thing',
      nextSeq: 0,
    } as never);
    const { ctx, captured } = fakeCtx();
    await new ControllerCoordinatorHandler(h.deps).execute(
      ctx,
      {},
      undefined as never,
    );
    // The FIRST planner call on resume is a REPLAN (durable lastOutcome seeded),
    // not a re-emit of the failed step s1.
    assert.match(seenSystems[0] ?? '', /A step just FAILED/);
    assert.ok(
      captured.find(
        (c) =>
          c.ok &&
          c.value.finishReason === 'stop' &&
          c.value.content === 'FINAL ANSWER',
      ),
    );
  });

  it('three-stage recovery: terminal store wins over phase (no re-finalize)', async () => {
    const backend = new InMemoryKnowledgeBackend();
    // Seed an ACTIVE bundle stuck in finalizing AND a terminal outcome for its runId.
    await persistBundle(backend, 'sess-1', {
      goal: 'g',
      plannerPrivate: '',
      budgets: { stepsUsed: 1, rewindsUsed: 0 },
      runId: 'R1',
      runState: 'active',
      runPhase: 'finalizing',
      originalRequest: 'do the thing',
      nextSeq: 1,
    } as never);
    const { writeTerminal } = await import('../run-scope.js');
    await writeTerminal(
      backend,
      'sess-1',
      'R1',
      { kind: 'success', answer: 'ALREADY' },
      60000,
      '2026-06-10T00:00:00.000Z',
    );
    const h = harness({ evaluator: [], planner: [], executor: [] });
    h.deps.backend = backend;
    h.deps.now = () => '2026-06-10T00:00:01.000Z';
    const { ctx, captured } = fakeCtx({ textOrMessages: 'do the thing' });
    await new ControllerCoordinatorHandler(h.deps).execute(ctx, {}, undefined);
    assert.ok(
      captured.find(
        (c) =>
          c.ok &&
          c.value.finishReason === 'stop' &&
          c.value.content === 'ALREADY',
      ),
      'adopted terminal outcome without re-finalizing',
    );
  });

  it('planner replan crash-guard: a crash mid-replan charges plannerResumeCount, capped', async () => {
    // Seed awaiting-replan with plannerCallInFlight already true (a crash during a
    // prior replan) → recovery charges plannerResumeCount; with cap 0 it aborts.
    const backend = new InMemoryKnowledgeBackend();
    await persistBundle(backend, 'sess-1', {
      goal: 'g',
      plannerPrivate: '',
      budgets: { stepsUsed: 1, rewindsUsed: 0 },
      runId: 'R1',
      runState: 'active',
      runPhase: 'executing',
      originalRequest: 'x',
      nextSeq: 0,
      inFlightStep: {
        seq: 0,
        step: { name: 's1', instructions: 'i' },
        attempt: 0,
        resumeCount: 0,
        phase: 'awaiting-replan',
        transcript: [],
        toolCallCount: 0,
      },
      plannerCallInFlight: true,
      plannerResumeCount: 0,
    } as never);
    const h = harness({
      evaluator: [],
      planner: [{ kind: 'content', content: JSON.stringify({ plan: [] }) }],
      executor: [],
      config: {
        ...baseConfig(),
        budgets: { ...baseConfig().budgets, maxPlannerResumes: 0 },
      },
    });
    h.deps.backend = backend;
    const { ctx, captured } = fakeCtx({ textOrMessages: 'x' });
    await new ControllerCoordinatorHandler(h.deps).execute(ctx, {}, undefined);
    assert.ok(
      captured.find(
        (c) => c.ok && /unable|abort|planner/i.test(c.value.content),
      ),
      'replan crash-loop aborted via maxPlannerResumes',
    );
    const bundle = await hydrateBundle(backend, 'sess-1');
    assert.equal(bundle.runState, 'terminal');
  });

  it('done → finalizer composes from approved results; terminal store written first', async () => {
    const h = harness({
      evaluator: [{ kind: 'content', content: 'Goal' }],
      planner: [
        {
          kind: 'content',
          content: JSON.stringify({
            plan: [{ name: 's1', instructions: 'do' }],
          }),
        },
        // finalize: planner's done.result is IGNORED when deps.finalizer is set;
        // the finalizer's return value is the surfaced answer. Still must provide
        // a planner finalize reply (FINALIZE_SYSTEM is always called by the planner).
        { kind: 'content', content: 'IGNORED-when-finalizer-present' },
      ],
      executor: [{ kind: 'content', content: 'STEP RESULT' }],
    });
    // A rag whose list() actually filters written entries, so collectApproved
    // surfaces the step's committed result and we verify it flows to the finalizer
    // (the default stub list() returns [] → the content path would be untested).
    const written: KnowledgeEntry[] = [];
    const listRag: IKnowledgeRagHandle & { written: KnowledgeEntry[] } = {
      written,
      query: async () => [],
      async list(filter) {
        return written.filter(
          (e) =>
            (filter.runId === undefined || e.metadata.runId === filter.runId) &&
            (filter.artifactType === undefined ||
              e.metadata.artifactType === filter.artifactType),
        );
      },
      async write(e) {
        written.push(e);
      },
      fingerprint() {
        return 'stub';
      },
    };
    h.deps.knowledgeRagFor = () => listRag;
    h.deps.finalizer = {
      async finalize(_g, _r, approved) {
        return `COMPOSED(${approved.map((a) => a.content).join(',')})`;
      },
    };
    const handler = new ControllerCoordinatorHandler(h.deps);
    const { ctx, captured } = fakeCtx();
    await handler.execute(ctx, {}, undefined);
    assert.ok(
      captured.find(
        (c) =>
          c.ok &&
          c.value.finishReason === 'stop' &&
          c.value.content === 'COMPOSED(STEP RESULT)',
      ),
      'finalizer composed the answer from the collected approved results',
    );
    const bundle = await hydrateBundle(h.backend, 'sess-1');
    assert.equal(bundle.runState, 'terminal');
    const { readTerminal } = await import('../run-scope.js');
    const term = await readTerminal(
      h.backend,
      'sess-1',
      bundle.runId!,
      new Date().toISOString(),
    );
    assert.equal(term?.kind, 'success');
  });

  it('skillsRecall result is threaded into finalizer opts.skillsBlock', async () => {
    const h = harness({
      evaluator: [{ kind: 'content', content: 'Goal' }],
      planner: [
        {
          kind: 'content',
          content: JSON.stringify({
            plan: [{ name: 's1', instructions: 'do' }],
          }),
        },
        { kind: 'content', content: 'IGNORED' },
      ],
      executor: [{ kind: 'content', content: 'STEP RESULT' }],
    });
    const written: KnowledgeEntry[] = [];
    const listRag: IKnowledgeRagHandle & { written: KnowledgeEntry[] } = {
      written,
      query: async () => [],
      async list(filter) {
        return written.filter(
          (e) =>
            (filter.runId === undefined || e.metadata.runId === filter.runId) &&
            (filter.artifactType === undefined ||
              e.metadata.artifactType === filter.artifactType),
        );
      },
      async write(e) {
        written.push(e);
      },
      fingerprint() {
        return 'stub';
      },
    };
    h.deps.knowledgeRagFor = () => listRag;
    // Inject skillsRecall — returns a known block.
    h.deps.skillsRecall = async (_goal) => 'Relevant skills:\n- footer LINE-X';
    // Replace finalizer with a capturing fake.
    let capturedOpts: Record<string, unknown> | undefined;
    h.deps.finalizer = {
      async finalize(_g, _r, _a, opts) {
        capturedOpts = opts as Record<string, unknown>;
        return 'answer';
      },
    };
    const handler = new ControllerCoordinatorHandler(h.deps);
    const { ctx, captured } = fakeCtx();
    await handler.execute(ctx, {}, undefined);
    assert.ok(
      captured.find((c) => c.ok && c.value.finishReason === 'stop'),
      'run reached done',
    );
    assert.equal(
      capturedOpts?.skillsBlock,
      'Relevant skills:\n- footer LINE-X',
      'skillsBlock from skillsRecall is passed to the finalizer',
    );
  });

  it('when skillsRecall is absent, finalizer opts.skillsBlock is undefined', async () => {
    const h = harness({
      evaluator: [{ kind: 'content', content: 'Goal' }],
      planner: [
        {
          kind: 'content',
          content: JSON.stringify({
            plan: [{ name: 's1', instructions: 'do' }],
          }),
        },
        { kind: 'content', content: 'IGNORED' },
      ],
      executor: [{ kind: 'content', content: 'STEP RESULT' }],
    });
    const written: KnowledgeEntry[] = [];
    const listRag: IKnowledgeRagHandle & { written: KnowledgeEntry[] } = {
      written,
      query: async () => [],
      async list(filter) {
        return written.filter(
          (e) =>
            (filter.runId === undefined || e.metadata.runId === filter.runId) &&
            (filter.artifactType === undefined ||
              e.metadata.artifactType === filter.artifactType),
        );
      },
      async write(e) {
        written.push(e);
      },
      fingerprint() {
        return 'stub';
      },
    };
    h.deps.knowledgeRagFor = () => listRag;
    // No skillsRecall set — h.deps.skillsRecall remains undefined.
    let capturedOpts: Record<string, unknown> | undefined;
    h.deps.finalizer = {
      async finalize(_g, _r, _a, opts) {
        capturedOpts = opts as Record<string, unknown>;
        return 'answer';
      },
    };
    const handler = new ControllerCoordinatorHandler(h.deps);
    const { ctx, captured } = fakeCtx();
    await handler.execute(ctx, {}, undefined);
    assert.ok(
      captured.find((c) => c.ok && c.value.finishReason === 'stop'),
      'run reached done',
    );
    assert.equal(
      capturedOpts?.skillsBlock,
      undefined,
      'skillsBlock is undefined when no skillsRecall',
    );
  });

  it('finalizer provider failure exhausts maxFinalizeRetries → onFinalizeExhausted:error → terminal error', async () => {
    const h = harness({
      evaluator: [{ kind: 'content', content: 'Goal' }],
      planner: [
        {
          kind: 'content',
          content: JSON.stringify({
            plan: [{ name: 's1', instructions: 'do' }],
          }),
        },
        // finalize: plain text; finalizer will throw and exhaust retries
        { kind: 'content', content: 'r' },
      ],
      executor: [{ kind: 'content', content: 'STEP' }],
      config: {
        ...baseConfig(),
        onFinalizeExhausted: 'error',
        budgets: { ...baseConfig().budgets, maxFinalizeRetries: 1 },
      },
    });
    h.deps.finalizer = {
      async finalize() {
        throw new Error('finalizer down');
      },
    };
    const handler = new ControllerCoordinatorHandler(h.deps);
    const { ctx, captured } = fakeCtx();
    await handler.execute(ctx, {}, undefined);
    assert.ok(
      captured.find((c) => c.ok && /Error:/.test(c.value.content)),
      'terminal error surfaced',
    );
    const bundle = await hydrateBundle(h.backend, 'sess-1');
    assert.equal(bundle.runState, 'terminal');
    const { readTerminal } = await import('../run-scope.js');
    const term = await readTerminal(
      h.backend,
      'sess-1',
      bundle.runId!,
      new Date().toISOString(),
    );
    assert.equal(term?.kind, 'error');
  });

  it('empty clarify answer is rejected: stays suspended, re-asks', async () => {
    const backend = new InMemoryKnowledgeBackend();
    await persistBundle(backend, 'sess-1', {
      goal: '',
      plannerPrivate: '',
      budgets: { stepsUsed: 0, rewindsUsed: 0 },
      runId: 'R1',
      runState: 'suspended',
      runPhase: 'evaluating',
      originalRequest: 'orig',
      pending: {
        kind: 'clarify',
        question: 'which table?',
        position: 'goal',
        proposedTarget: 'T100',
      },
    } as never);
    const h = harness({ evaluator: [], planner: [], executor: [] });
    h.deps.backend = backend;
    // Whitespace-only answer + the runId token (the answer's fingerprint differs).
    const { ctx, captured } = fakeCtx({
      textOrMessages: '   ',
      options: { runId: 'R1' } as never,
    });
    await new ControllerCoordinatorHandler(h.deps).execute(ctx, {}, undefined);
    const b = await hydrateBundle(backend, 'sess-1');
    assert.equal(b.goal, '', 'empty answer did NOT become the goal');
    assert.equal(b.pending?.kind, 'clarify', 'still suspended on clarify');
    assert.ok(
      captured.find((c) => c.ok && /which table/i.test(c.value.content)),
      're-surfaced the question',
    );
  });

  it('per-requires evidence is passed to the reviewer', async () => {
    let seenEvidence: unknown;
    const h = harness({
      evaluator: [{ kind: 'content', content: 'Goal' }],
      planner: [
        {
          kind: 'content',
          content: JSON.stringify({
            plan: [
              {
                name: 's1',
                instructions: 'do',
                requires: ['table T100', 'domain ZD'],
              },
            ],
          }),
        },
        { kind: 'content', content: 'd' },
      ],
      executor: [{ kind: 'content', content: 'r' }],
      ragQuery: async (text) =>
        /T100/.test(text)
          ? [
              {
                content: 'T100 def',
                metadata: {
                  traceId: 't',
                  turnId: 't',
                  stepperId: 'controller',
                  task: 'x',
                  artifactType: 'mcp-result',
                  createdAt: '2026-06-10T00:00:00.000Z',
                },
              },
            ]
          : [],
    });
    h.deps.reviewer = {
      async review(_s, evidence) {
        seenEvidence = evidence;
        return {
          kind: 'outcome',
          outcome: { status: 'ok', approved: 'r', remainder: '', note: '' },
        };
      },
    };
    await new ControllerCoordinatorHandler(h.deps).execute(
      fakeCtx().ctx,
      {},
      undefined,
    );
    // Evidence carries the closest artifact's CONTENT (topArtifact) for the reviewer
    // to judge — not just a count-based hit.
    assert.deepEqual(seenEvidence, [
      { ref: 'table T100', hit: true, topArtifact: 'T100 def' },
      { ref: 'domain ZD', hit: false, topArtifact: undefined },
    ]);
  });

  it('step-result recall is injected + budget-capped; mcp-result recall is NOT in the static prefix (moved to the context strategy, Task 11)', async () => {
    const seenMessages: Message[][] = [];
    const h = harness({
      evaluator: [{ kind: 'content', content: 'Goal' }],
      planner: [
        {
          kind: 'content',
          content: JSON.stringify({
            plan: [{ name: 's1', instructions: 'analyze' }],
          }),
        },
        { kind: 'content', content: 'd' },
      ],
      executor: [],
      // step-result query → one HUGE step artifact; mcp-result query → a distinct artifact.
      ragQuery: async (_text, opts) => {
        const kind = (opts?.filter?.artifactType as string[])?.[0];
        const md = (t: string) => ({
          traceId: 't',
          turnId: 't',
          stepperId: 'controller',
          task: 'x',
          artifactType: t,
          createdAt: '2026-06-10T00:00:00.000Z',
        });
        if (kind === 'step-result')
          return [
            {
              content: 'S'.repeat(50000),
              metadata: {
                ...md('step-result'),
                seq: 0,
                attempt: 0,
                status: 'ok',
              },
            },
          ];
        if (kind === 'mcp-result')
          return [
            {
              content: 'MCP-CONTEXT-XYZ',
              metadata: { ...md('mcp-result'), identityKey: 'K1' },
            },
          ];
        return [];
      },
    });
    h.deps.executor = {
      async send(messages: Message[]) {
        seenMessages.push(messages);
        return { kind: 'content', content: 'r' };
      },
    };
    await new ControllerCoordinatorHandler(h.deps).execute(
      fakeCtx().ctx,
      {},
      undefined,
    );
    const joined = seenMessages[0]
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .join('\n');
    // NOTE (Task 11): the mcp-result recall moved OUT of the executor static prefix
    // and into the injected context strategy (Window keeps a bounded buffer;
    // RagRecall recalls). The default (LegacyAccumulate) strategy injects no mcp
    // recall, so the mcp-result context is NOT in the static prefix here.
    assert.ok(
      !joined.includes('MCP-CONTEXT-XYZ'),
      'mcp-result recall is no longer part of the static prefix (context strategy owns it)',
    );
    // The step-result recall stays in the static prefix and is budget-capped
    // (RECALL_MAX_CHARS_STEP=2000), not injected whole.
    assert.ok(
      joined.includes('S'.repeat(1)) && !joined.includes('S'.repeat(2001)),
      'the 50k step-result was injected but truncated to its own char budget',
    );
  });

  it('#213 cut: first isError:true tool round settles failed — no retry, no confabulation, no reviewer, durable step-result', async () => {
    const h = harness({
      evaluator: [{ kind: 'content', content: 'Goal' }],
      planner: [
        // create-plan: one tool step
        {
          kind: 'content',
          content: JSON.stringify({
            plan: [{ name: 's1', instructions: 'update the object' }],
          }),
        },
        // replan after the cut (lastOutcome='failed'): nothing left → finalize
        { kind: 'content', content: JSON.stringify({ plan: [] }) },
        // finalize text (plain text → done result)
        { kind: 'content', content: 'the object is locked; not updated' },
      ],
      executor: [
        toolCall('UpdateObj', { name: 'ZOBJ' }),
        // A confabulated "success" summary the executor WOULD emit on the next
        // round — must never be consumed, because the cut ends the tool loop.
        { kind: 'content', content: 'updated successfully' },
      ],
      selectTools: [{ name: 'UpdateObj', description: '', inputSchema: {} }],
      isExternalTool: () => false,
      callMcpReturns: { text: 'ZOBJ is locked by user ALICE', isError: true },
    });
    // Reviewer spy: proves the reviewer is NOT invoked for a cut step (the
    // executor tool-loop is cut before any content round reaches the reviewer).
    let reviewCalls = 0;
    h.deps.reviewer = {
      async review() {
        reviewCalls++;
        return {
          kind: 'outcome',
          outcome: { status: 'ok', approved: '', remainder: '' },
        };
      },
    };
    const handler = new ControllerCoordinatorHandler(h.deps);
    const { ctx, captured } = fakeCtx();

    const ret = await handler.execute(ctx, {}, undefined);

    assert.equal(ret, true);
    // 1. The tool was called exactly once — NOT retried on the locked object.
    assert.equal(h.mcpCalls.length, 1);
    // 2. The reviewer was never invoked (the step was cut, not reviewed).
    assert.equal(reviewCalls, 0, 'reviewer must NOT run for a cut step');
    // 3. No confabulation: the run never surfaces the executor's "updated
    //    successfully" summary (that round is never reached).
    assert.ok(
      !captured.some((c) => c.ok && c.value.content === 'updated successfully'),
      'confabulated success summary must never be surfaced',
    );
    // 4. Durable carrier: a 'failed' step-result artifact carrying the tool
    //    error text was written (via writeControlFailure) — NOT settleStep alone.
    const failed = h.rag.written.filter(
      (e) =>
        e.metadata.artifactType === 'step-result' &&
        e.metadata.status === 'failed',
    );
    assert.ok(failed.length >= 1, 'a failed step-result artifact was written');
    assert.match(
      String(failed[0].metadata.note ?? ''),
      /ZOBJ is locked by user ALICE/,
      'the failed step-result carries the tool error text',
    );
    // 5. stepsUsed bumped + the tool error text is in the durable plannerPrivate.
    const bundle = await hydrateBundle(h.backend, 'sess-1');
    assert.equal(bundle.budgets.stepsUsed, 1);
    assert.match(bundle.plannerPrivate, /ZOBJ is locked by user ALICE/);
    assert.match(bundle.plannerPrivate, /control-failed/);
  });

  it('#213 planner error decision terminates the run with the real tool error', async () => {
    const h = harness({
      evaluator: [{ kind: 'content', content: 'Goal' }],
      planner: [
        // create-plan emits the cannot-proceed error decision directly
        {
          kind: 'content',
          content: JSON.stringify({
            kind: 'error',
            error: 'domain ZD_YTEST already exists (name pinned by request)',
          }),
        },
      ],
      executor: [],
    });
    const handler = new ControllerCoordinatorHandler(h.deps);
    const { ctx, captured } = fakeCtx();

    const ret = await handler.execute(ctx, {}, undefined);

    assert.equal(ret, true);
    // The consumer receives the REAL failure, not (no response) / a generic abort.
    assert.ok(
      captured.some(
        (c) =>
          c.ok &&
          c.value.finishReason === 'stop' &&
          /domain ZD_YTEST already exists/.test(c.value.content),
      ),
      'the real tool error must reach the consumer',
    );
    const bundle = await hydrateBundle(h.backend, 'sess-1');
    assert.equal(bundle.runState, 'terminal');
  });
});

describe('Phase 2 — Live Digest Board integration', () => {
  it('handler persists a plan-decision after the planner creates a plan', async () => {
    const h = harness({
      evaluator: [{ kind: 'content', content: 'Goal: do it' }],
      // Adaptive planner: first call creates a 1-step plan; second call finalizes.
      planner: [
        {
          kind: 'content',
          content: JSON.stringify({
            plan: [{ name: 's1', instructions: 'fetch A' }],
          }),
        },
        { kind: 'content', content: 'FINAL' },
      ],
      executor: [{ kind: 'content', content: 'did s1' }],
      config: { ...baseConfig() },
    });
    const { ctx } = fakeCtx();
    await new ControllerCoordinatorHandler(h.deps).execute(ctx, {}, undefined);

    const bundle = await hydrateBundle(h.backend, 'sess-1');
    const runId = bundle.runId;
    assert.ok(runId, 'run has a runId');

    const all = await h.backend.scan('sess-1');
    const decisions = all.filter(
      (e) =>
        e.metadata.artifactType === 'plan-decision' &&
        e.metadata.runId === runId,
    );
    assert.ok(decisions.length >= 1, 'at least one plan-decision persisted');
  });

  it('handler writes stepId + digest on the step-result', async () => {
    const h = harness({
      evaluator: [{ kind: 'content', content: 'Goal: do it' }],
      planner: [
        {
          kind: 'content',
          content: JSON.stringify({
            plan: [{ name: 's1', instructions: 'fetch A' }],
          }),
        },
        { kind: 'content', content: 'FINAL' },
      ],
      executor: [{ kind: 'content', content: 'did s1' }],
      config: { ...baseConfig() },
    });
    const { ctx } = fakeCtx();
    await new ControllerCoordinatorHandler(h.deps).execute(ctx, {}, undefined);

    const results = h.rag.written.filter(
      (e) => e.metadata.artifactType === 'step-result',
    );
    assert.ok(results.length >= 1, 'at least one step-result written');
    assert.ok(results[0].metadata.stepId, 'stepId persisted on step-result');
    assert.ok(
      typeof results[0].metadata.digest === 'string',
      'digest persisted on step-result',
    );
  });

  it('I2: board→planner path — planner receives a non-empty boardText containing the settled step digest', async () => {
    // Use a proxying rag whose list() reads from the InMemoryKnowledgeBackend so
    // renderLiveBoard returns real artifacts (plan-decision, step-start, step-result).
    // We keep the default stubRag for write() so other assertions still work, but
    // override list() to scan the backend.  Approach (b): isolated rag for this test
    // only — avoids disrupting other tests that rely on list() returning [].
    const backend = new InMemoryKnowledgeBackend();
    const writtenEntries: KnowledgeEntry[] = [];

    const proxyRag: IKnowledgeRagHandle & { written: KnowledgeEntry[] } = {
      written: writtenEntries,
      query: async () => [],
      async list(filter) {
        const all = await backend.scan('sess-1');
        return all.filter((e) => {
          if (filter.runId !== undefined && e.metadata.runId !== filter.runId)
            return false;
          if (filter.artifactType !== undefined) {
            const af = filter.artifactType;
            if (typeof af === 'string') {
              if (e.metadata.artifactType !== af) return false;
            } else {
              if (!af.includes(e.metadata.artifactType as string)) return false;
            }
          }
          return true;
        });
      },
      async write(entry) {
        writtenEntries.push(entry);
        // Also persist step-result entries to the backend so the board can read them.
        if (entry.metadata.artifactType === 'step-result') {
          await backend.put('sess-1', entry);
        }
      },
      fingerprint() {
        return 'proxy';
      },
    };

    // Capture all messages the planner receives so we can assert boardText content.
    const plannerMessages: Array<{ role: string; content: string }[]> = [];
    const plannerReplies: SubagentResult[] = [
      {
        kind: 'content',
        content: JSON.stringify({
          plan: [{ name: 's1', instructions: 'fetch-digest-me' }],
        }),
      },
      { kind: 'content', content: 'BOARD_FINAL' },
    ];
    const recordingPlanner: ISubagentClient = {
      async send(messages) {
        plannerMessages.push(
          messages.map((m) => ({
            role: m.role,
            content: typeof m.content === 'string' ? m.content : '',
          })),
        );
        return plannerReplies.shift() ?? { kind: 'content', content: '' };
      },
    };

    const h = harness({
      evaluator: [{ kind: 'content', content: 'Goal: do it' }],
      planner: [], // overridden below
      executor: [{ kind: 'content', content: 'STEP-RESULT-CONTENT' }],
      config: { ...baseConfig() },
    });
    h.deps.backend = backend;
    h.deps.knowledgeRagFor = () => proxyRag;
    h.deps.planner = recordingPlanner;

    const { ctx, captured } = fakeCtx();
    const ret = await new ControllerCoordinatorHandler(h.deps).execute(
      ctx,
      {},
      undefined,
    );

    assert.equal(ret, true);
    assert.ok(
      captured.find(
        (c) =>
          c.ok &&
          c.value.finishReason === 'stop' &&
          c.value.content === 'BOARD_FINAL',
      ),
      'run reached done',
    );

    // The planner was called at least twice: (1) create plan, (2) finalize.
    assert.ok(plannerMessages.length >= 2, 'planner called at least twice');

    // Find the step-result written with a digest — that digest must appear in the
    // second planner call (the finalize call that follows the executor).
    const stepResult = writtenEntries.find(
      (e) =>
        e.metadata.artifactType === 'step-result' &&
        typeof e.metadata.digest === 'string',
    );
    assert.ok(stepResult, 'a step-result with a digest was written');
    const digest = (
      stepResult as typeof stepResult & { metadata: { digest: string } }
    ).metadata.digest;
    assert.ok(digest.length > 0, 'digest is non-empty');

    // The SECOND planner call (finalize) must include the board containing the digest.
    const secondCallText = plannerMessages
      .slice(1)
      .flatMap((msgs) => msgs.map((m) => m.content))
      .join('\n');
    assert.ok(
      secondCallText.includes(digest),
      `second planner call boardText must contain the settled step digest "${digest}"`,
    );
  });

  it('handler writes a failed step-result with digest on a control failure', async () => {
    // Fixture: executor always returns an error → retries exhaust → settle('failed').
    // maxRetries=0 so the single error immediately exhausts retries.
    const h = harness({
      evaluator: [{ kind: 'content', content: 'Goal: do it' }],
      planner: [
        {
          kind: 'content',
          content: JSON.stringify({
            plan: [{ name: 's1', instructions: 'fetch A' }],
          }),
        },
        {
          kind: 'content',
          content: JSON.stringify({ plan: [] }),
        },
        { kind: 'content', content: 'FINAL' },
      ],
      executor: [{ kind: 'error', error: 'boom' }],
      config: {
        ...baseConfig(),
        budgets: { ...baseConfig().budgets, maxRetries: 0 },
      },
    });
    const { ctx } = fakeCtx();
    await new ControllerCoordinatorHandler(h.deps).execute(ctx, {}, undefined);

    const failed = h.rag.written.filter(
      (e) =>
        e.metadata.artifactType === 'step-result' &&
        e.metadata.status === 'failed',
    );
    assert.ok(failed.length >= 1, 'a failed step-result exists');
    assert.ok(
      typeof failed[0].metadata.digest === 'string' &&
        failed[0].metadata.digest.length > 0,
      'control failure carries a digest',
    );
    assert.ok(
      failed[0].metadata.stepId !== undefined,
      'control failure carries stepId',
    );
  });
});

describe('parseNextStep shape matrix', () => {
  it('valid done → { kind: "done", result }', () => {
    assert.deepEqual(parseNextStep('{"kind":"done","result":"R"}'), {
      kind: 'done',
      result: 'R',
    });
  });
  it('valid next → { kind: "next", step }', () => {
    assert.deepEqual(
      parseNextStep('{"kind":"next","step":{"name":"n","instructions":"i"}}'),
      { kind: 'next', step: { name: 'n', instructions: 'i' } },
    );
  });
  it('valid rewind → { kind: "rewind", reason }', () => {
    assert.deepEqual(parseNextStep('{"kind":"rewind","reason":"why"}'), {
      kind: 'rewind',
      reason: 'why',
    });
  });
  it('JSON-fenced input parses to the next shape', () => {
    const fenced =
      'Some prose\n```json\n{"kind":"next","step":{"name":"n","instructions":"i"}}\n```\nmore prose';
    assert.deepEqual(parseNextStep(fenced), {
      kind: 'next',
      step: { name: 'n', instructions: 'i' },
    });
  });
  it('invalid input → null', () => {
    assert.equal(parseNextStep('not json at all'), null);
  });
  it('partial/malformed JSON → null', () => {
    assert.equal(parseNextStep('{"kind":"next","step":{"name":"n"}'), null);
  });
});

describe('parseNextStep requires validation', () => {
  it('rejects a malformed requires (non-string / oversized) → null (parse-retry)', () => {
    assert.equal(
      parseNextStep(
        JSON.stringify({
          kind: 'next',
          step: { name: 's', instructions: 'i', requires: [123, ''] },
        }),
      ),
      null,
    );
    assert.equal(
      parseNextStep(
        JSON.stringify({
          kind: 'next',
          step: { name: 's', instructions: 'i', requires: ['x'.repeat(500)] },
        }),
      ),
      null,
    );
  });
  it('an empty requires becomes a step with no requires', () => {
    const r = parseNextStep(
      JSON.stringify({
        kind: 'next',
        step: { name: 's', instructions: 'i', requires: [] },
      }),
    );
    assert.equal(r?.kind, 'next');
    assert.equal(r?.kind === 'next' ? r.step.requires : 'x', undefined);
  });
  it('trims valid requires entries', () => {
    const r = parseNextStep(
      JSON.stringify({
        kind: 'next',
        step: { name: 's', instructions: 'i', requires: ['  table T100  '] },
      }),
    );
    assert.deepEqual(r?.kind === 'next' ? r.step.requires : [], ['table T100']);
  });
});

// ---------------------------------------------------------------------------
// Task 5 — the controller serves `type: 'wait'` steps itself (no executor,
// no reviewer, no MCP, no tokens).
// ---------------------------------------------------------------------------

/** A wait strategy that never sleeps in real time; records the decided duration. */
const instantWaiter = (slept: number[] = []) => ({
  name: 'test-instant',
  async wait(ms: number) {
    slept.push(ms);
    return 'elapsed' as const;
  },
});

const waitStepJson = {
  name: 'settle',
  instructions: 'let it settle',
  type: 'wait',
  waitMs: 30_000,
};
const seededWaitStep = { ...waitStepJson, stepId: 'sw0' };

/** Planner script for a single-wait plan: create-plan then finalize. */
function waitPlanner(finalizeText = 'wait-final'): SubagentResult[] {
  return [
    { kind: 'content', content: JSON.stringify({ plan: [waitStepJson] }) },
    { kind: 'content', content: finalizeText },
  ];
}

/** Fresh single-wait harness with an injected instant waiter. */
function waitHarness(
  budgetsOver: Partial<ControllerConfig['budgets']> = {},
  slept: number[] = [],
): Harness {
  const h = harness({
    evaluator: [{ kind: 'content', content: 'Goal' }],
    planner: waitPlanner(),
    executor: [{ kind: 'content', content: 'should not be called' }],
    config: baseConfig(budgetsOver),
  });
  h.deps.waitStrategy = instantWaiter(slept);
  return h;
}

function stepResults(h: Harness): KnowledgeEntry[] {
  return h.rag.written.filter((e) => e.metadata.artifactType === 'step-result');
}

/** Run the handler and return the single step-result artifact the wait wrote. */
async function runAndReadStepResult(h: Harness): Promise<KnowledgeEntry> {
  await new ControllerCoordinatorHandler(h.deps).execute(
    fakeCtx().ctx,
    {},
    undefined,
  );
  const arts = stepResults(h);
  assert.ok(arts.length >= 1, 'a step-result artifact was written');
  return arts[arts.length - 1];
}

/** A KnowledgeBackend wrapper that records each persisted controller bundle. */
function spyBackend(
  sink: SessionBundle[],
  inner: KnowledgeBackend,
): KnowledgeBackend {
  return {
    async put(sessionId, entry, options) {
      if (entry.metadata.artifactType === 'controller-bundle') {
        try {
          sink.push(JSON.parse(entry.content) as SessionBundle);
        } catch {
          /* ignore malformed */
        }
      }
      return inner.put(sessionId, entry, options);
    },
    semanticQuery: (sessionId, text, k, filter, options) =>
      inner.semanticQuery(sessionId, text, k, filter, options),
    scan: (sessionId) => inner.scan(sessionId),
    deleteSession: (sessionId) => inner.deleteSession(sessionId),
    semanticRecallCapable: inner.semanticRecallCapable,
  };
}

/** Seed a bundle carrying an in-flight wait step so the resume path serves it. */
async function seedWaitResume(
  backend: KnowledgeBackend,
  inFlightOver: Record<string, unknown> = {},
  bundleOver: Partial<SessionBundle> = {},
): Promise<void> {
  await persistBundle(backend, 'sess-1', {
    goal: 'g',
    plannerPrivate: '',
    budgets: { stepsUsed: 0, rewindsUsed: 0 },
    runId: 'R1',
    runState: 'active',
    runPhase: 'executing',
    originalRequest: 'do the thing',
    nextSeq: 0,
    plan: [seededWaitStep],
    planCursor: 0,
    inFlightStep: {
      seq: 0,
      step: seededWaitStep,
      attempt: 0,
      resumeCount: 0,
      phase: 'executing',
      transcript: [],
      toolCallCount: 0,
      ...inFlightOver,
    },
    ...bundleOver,
  } as never);
}

describe('ControllerCoordinatorHandler — wait steps', () => {
  it('serves a wait step with zero executor, reviewer and MCP calls', async () => {
    let executorCalls = 0;
    let reviewerCalls = 0;
    const h = waitHarness();
    const realExecutor = h.deps.executor;
    h.deps.executor = {
      async send(...a: unknown[]) {
        executorCalls++;
        return (realExecutor.send as (...x: unknown[]) => unknown)(
          ...a,
        ) as never;
      },
    } as never;
    h.deps.reviewer = {
      async review() {
        reviewerCalls++;
        throw new Error('unreachable');
      },
    } as never;

    await new ControllerCoordinatorHandler(h.deps).execute(
      fakeCtx().ctx,
      {},
      undefined,
    );

    assert.equal(executorCalls, 0, 'executor must not be invoked for a wait');
    assert.equal(reviewerCalls, 0, 'reviewer must not be invoked for a wait');
    assert.equal(h.mcpCalls.length, 0, 'MCP must not be called for a wait');
  });

  it('serves a RESUMED wait without the executor — the crash-replay path', async () => {
    let executorCalls = 0;
    const h = waitHarness();
    // Resume: no create-plan needed (plan seeded); planner only finalizes.
    h.deps.planner = scriptedClient([
      { kind: 'content', content: 'resumed-final' },
    ]);
    await seedWaitResume(h.backend, {
      waitStartedAt: 1_000,
      appliedWaitMs: 30_000,
    });
    const realExecutor = h.deps.executor;
    h.deps.executor = {
      async send(...a: unknown[]) {
        executorCalls++;
        return (realExecutor.send as (...x: unknown[]) => unknown)(
          ...a,
        ) as never;
      },
    } as never;

    await new ControllerCoordinatorHandler(h.deps).execute(
      fakeCtx().ctx,
      {},
      undefined,
    );
    assert.equal(
      executorCalls,
      0,
      'a resumed wait must not reach the executor',
    );
  });

  it('a settled wait leaves the bundle exactly as an executed step would', async () => {
    // Executed-step baseline.
    const exec = harness({
      evaluator: [{ kind: 'content', content: 'Goal' }],
      planner: [
        {
          kind: 'content',
          content: JSON.stringify({
            plan: [{ name: 's1', instructions: 'do' }],
          }),
        },
        { kind: 'content', content: 'final' },
      ],
      executor: [{ kind: 'content', content: 'did s1' }],
    });
    await new ControllerCoordinatorHandler(exec.deps).execute(
      fakeCtx().ctx,
      {},
      undefined,
    );
    const eb = await hydrateBundle(exec.backend, 'sess-1');

    // Wait-step run under the same conditions.
    const w = waitHarness();
    await new ControllerCoordinatorHandler(w.deps).execute(
      fakeCtx().ctx,
      {},
      undefined,
    );
    const wb = await hydrateBundle(w.backend, 'sess-1');

    // Parity of every durable settle effect.
    assert.equal(wb.lastOutcome, eb.lastOutcome);
    assert.equal(wb.lastOutcome, 'advanced');
    assert.equal(wb.nextSeq, eb.nextSeq);
    assert.equal(wb.nextSeq, 1);
    assert.equal(
      wb.planCursor,
      eb.planCursor,
      'planner cursor advanced (onCommit)',
    );
    assert.equal(wb.planCursor, 1);
    assert.equal(wb.inFlightStep, undefined);
    assert.equal(wb.budgets.stepsUsed, eb.budgets.stepsUsed);
    // The wait appears on the board (recordStepControl → plannerPrivate).
    assert.match(wb.plannerPrivate, /\[seq 0 settle ok\]/);
  });

  it('a settled wait consumes one stepsUsed unit', async () => {
    const h = waitHarness();
    await new ControllerCoordinatorHandler(h.deps).execute(
      fakeCtx().ctx,
      {},
      undefined,
    );
    const bundle = await hydrateBundle(h.backend, 'sess-1');
    assert.equal(bundle.budgets.stepsUsed, 1);
  });

  it('a wait charges waitMsUsed and persists the deadline BEFORE sleeping', async () => {
    const persisted: SessionBundle[] = [];
    const h = waitHarness();
    h.deps.backend = spyBackend(persisted, h.deps.backend);
    await new ControllerCoordinatorHandler(h.deps).execute(
      fakeCtx().ctx,
      {},
      undefined,
    );
    const withDeadline = persisted.find(
      (b) => b.inFlightStep?.appliedWaitMs !== undefined,
    );
    assert.ok(withDeadline, 'deadline persisted before the sleep resolves');
    assert.equal(withDeadline?.inFlightStep?.appliedWaitMs, 30_000);
    assert.equal(withDeadline?.budgets.waitMsUsed, 30_000);
    const bundle = await hydrateBundle(h.deps.backend, 'sess-1');
    assert.equal(bundle.budgets.waitMsUsed, 30_000);
  });

  it('the controller decides the wait duration (slept records it)', async () => {
    const slept: number[] = [];
    const h = waitHarness({}, slept);
    await new ControllerCoordinatorHandler(h.deps).execute(
      fakeCtx().ctx,
      {},
      undefined,
    );
    assert.deepEqual(slept, [30_000]);
  });

  it('clamped wait records the requested and the applied duration', async () => {
    const h = waitHarness({ maxWaitMs: 600_000 });
    // waitMs 3_600_000 > maxWaitMs → applied 600_000, clamped.
    h.deps.planner = scriptedClient([
      {
        kind: 'content',
        content: JSON.stringify({
          plan: [{ ...waitStepJson, waitMs: 3_600_000 }],
        }),
      },
      { kind: 'content', content: 'final' },
    ]);
    const art = await runAndReadStepResult(h);
    assert.equal(art.metadata.status, 'ok');
    assert.match(art.content, /600000/);
    assert.match(art.metadata.note ?? '', /clamp/i);
  });

  it('a partial cap truncation reports a clamp, NOT "no wait performed"', async () => {
    const h = waitHarness({ maxTotalWaitMs: 10_000 });
    // waitMs 30_000, only 10_000 of the total budget remains → applied 10_000.
    const art = await runAndReadStepResult(h);
    assert.match(art.content, /10000/);
    assert.doesNotMatch(art.content, /No wait performed/);
    assert.match(art.metadata.note ?? '', /clamp/i);
  });

  it('total cap spent → wait is skipped without sleeping', async () => {
    const h = waitHarness({ maxTotalWaitMs: 0 });
    const art = await runAndReadStepResult(h);
    assert.match(art.content, /No wait performed/);
    assert.match(art.metadata.note ?? '', /budget spent/i);
  });

  it('resumed after an elapsed deadline settles without sleeping again', async () => {
    const h = waitHarness();
    h.deps.planner = scriptedClient([
      { kind: 'content', content: 'resumed-final' },
    ]);
    await seedWaitResume(h.backend, {
      waitStartedAt: 1_000,
      appliedWaitMs: 30_000,
    });
    const art = await runAndReadStepResult(h);
    assert.equal(art.metadata.status, 'ok');
    assert.match(art.content, /already elapsed/);
    assert.match(art.metadata.note ?? '', /resumed after deadline/);
  });

  it('repeated abort/resume of a wait does NOT consume maxStepResumes', async () => {
    const h = waitHarness();
    h.deps.planner = scriptedClient([
      { kind: 'content', content: 'resumed-final' },
    ]);
    // resumeCount already at the cap; a wait remainder must not be charged.
    await seedWaitResume(
      h.backend,
      { waitStartedAt: 1_000, appliedWaitMs: 30_000, resumeCount: 3 },
      {},
    );
    const { ctx, captured } = fakeCtx();
    await new ControllerCoordinatorHandler(h.deps).execute(ctx, {}, undefined);
    assert.ok(
      !captured.find(
        (c) => c.ok && /maxStepResumes/.test(c.value.content ?? ''),
      ),
      'a resumed wait must not be aborted as a crash replay',
    );
    const bundle = await hydrateBundle(h.backend, 'sess-1');
    assert.equal(bundle.budgets.stepsUsed, 1, 'the resumed wait advanced');
  });

  it('a torn deadline yields a control-failure and a replan, not a sleep', async () => {
    const h = waitHarness();
    // Empty planner queue → the failed wait replans (which never parses) and the
    // run escalates, leaving the in-flight step intact for inspection.
    h.deps.planner = scriptedClient([]);
    const slept: number[] = [];
    h.deps.waitStrategy = instantWaiter(slept);
    await seedWaitResume(h.backend, { waitStartedAt: 5_000 }); // appliedWaitMs absent
    const art = await runAndReadStepResult(h);
    assert.equal(art.metadata.status, 'failed');
    assert.match(
      art.metadata.note ?? '',
      /half-written|missing appliedWaitMs/i,
    );
    assert.deepEqual(slept, [], 'a torn deadline never sleeps');

    const bundle = await hydrateBundle(h.backend, 'sess-1');
    assert.match(
      bundle.plannerPrivate,
      /control-failed.*half-written/s,
      'the planner must learn WHY it is replanning',
    );
    assert.equal(
      bundle.inFlightStep?.controlFailure?.reason,
      'control-failure',
    );
    assert.equal(bundle.inFlightStep?.phase, 'awaiting-replan');
  });

  it('an abort mid-wait writes no artifact, does not advance, keeps the deadline', async () => {
    const h = waitHarness({}, []);
    h.deps.planner = scriptedClient([
      {
        kind: 'content',
        content: JSON.stringify({
          plan: [{ ...waitStepJson, waitMs: 60_000 }],
        }),
      },
      { kind: 'content', content: 'final' },
    ]);
    h.deps.waitStrategy = {
      name: 'test-abort',
      async wait() {
        return 'aborted' as const;
      },
    };
    await new ControllerCoordinatorHandler(h.deps).execute(
      fakeCtx().ctx,
      {},
      undefined,
    );
    const bundle = await hydrateBundle(h.backend, 'sess-1');
    assert.equal(bundle.budgets.stepsUsed, 0, 'must not advance');
    assert.ok(bundle.inFlightStep?.appliedWaitMs, 'deadline stays persisted');
    assert.equal(
      bundle.budgets.waitMsUsed,
      60_000,
      'charged once, not refunded',
    );
    assert.equal(stepResults(h).length, 0, 'no artifact written on abort');
  });

  it('a resumed wait does not re-charge waitMsUsed', async () => {
    const h = waitHarness();
    h.deps.planner = scriptedClient([
      { kind: 'content', content: 'resumed-final' },
    ]);
    await seedWaitResume(
      h.backend,
      { waitStartedAt: 1_000, appliedWaitMs: 60_000 },
      { budgets: { stepsUsed: 0, rewindsUsed: 0, waitMsUsed: 60_000 } },
    );
    await new ControllerCoordinatorHandler(h.deps).execute(
      fakeCtx().ctx,
      {},
      undefined,
    );
    const bundle = await hydrateBundle(h.backend, 'sess-1');
    assert.equal(bundle.budgets.waitMsUsed, 60_000);
  });

  it('a plan with no wait step still reaches the executor once', async () => {
    let executorCalls = 0;
    const h = harness({
      evaluator: [{ kind: 'content', content: 'Goal' }],
      planner: [
        {
          kind: 'content',
          content: JSON.stringify({
            plan: [{ name: 's1', instructions: 'do' }],
          }),
        },
        { kind: 'content', content: 'final' },
      ],
      executor: [{ kind: 'content', content: 'did s1' }],
    });
    h.deps.waitStrategy = instantWaiter();
    const realExecutor = h.deps.executor;
    h.deps.executor = {
      async send(...a: unknown[]) {
        executorCalls++;
        return (realExecutor.send as (...x: unknown[]) => unknown)(
          ...a,
        ) as never;
      },
    } as never;
    await new ControllerCoordinatorHandler(h.deps).execute(
      fakeCtx().ctx,
      {},
      undefined,
    );
    assert.equal(executorCalls, 1, 'a normal step reaches the executor once');
  });
});
