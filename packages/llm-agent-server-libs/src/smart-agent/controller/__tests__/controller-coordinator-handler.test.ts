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
import type { PipelineContext } from '@mcp-abap-adt/llm-agent-libs';
import {
  InMemoryKnowledgeBackend,
  SessionRequestLogger,
} from '@mcp-abap-adt/llm-agent-libs';
import {
  ControllerCoordinatorHandler,
  type ControllerHandlerDeps,
} from '../controller-coordinator-handler.js';
import { hydrateBundle, persistBundle } from '../session-bundle.js';
import type { ISubagentClient } from '../subagent-client.js';
import type { ControllerConfig, SubagentResult } from '../types.js';

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
  callMcpReturns?: string;
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
      return opts.callMcpReturns ?? 'mcp-out';
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
        {
          kind: 'content',
          content: JSON.stringify({
            kind: 'next',
            step: { name: 's1', instructions: 'do' },
          }),
        },
        {
          kind: 'content',
          content: JSON.stringify({ kind: 'done', result: 'finished' }),
        },
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
            kind: 'next',
            step: { name: 's1', instructions: 'do' },
          }),
        },
        {
          kind: 'content',
          content: JSON.stringify({ kind: 'done', result: 'final-out' }),
        },
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
    assert.ok(
      h.rag.written.find(
        (e) =>
          e.metadata.artifactType === 'mcp-result' &&
          e.metadata.toolName === 'GetX',
      ),
    );
  });

  it('external tool: surfaces tool_calls chunk + suspends with pending marker', async () => {
    const h = harness({
      evaluator: [{ kind: 'content', content: 'Goal' }],
      planner: [
        {
          kind: 'content',
          content: JSON.stringify({
            kind: 'next',
            step: { name: 's1', instructions: 'do' },
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
            kind: 'next',
            step: { name: 's1', instructions: 'do' },
          }),
        },
      ],
      executor: [toolCall('ExtTool', { q: 'abc' })],
      isExternalTool: () => true,
    });
    const handler = new ControllerCoordinatorHandler(h.deps);
    await handler.execute(fakeCtx().ctx, {}, undefined);
    const extId = externalToolCallId('ExtTool', { q: 'abc' });

    // Second leg: planner now completes; provide the external result.
    (h.deps.planner as ISubagentClient & { send: unknown }).send = async () =>
      ({
        kind: 'content',
        content: JSON.stringify({ kind: 'done', result: 'resumed-done' }),
      }) as SubagentResult;
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
    const h = harness({
      evaluator: [{ kind: 'content', content: 'Goal' }],
      planner: [
        {
          kind: 'content',
          content: JSON.stringify({ kind: 'rewind', reason: 'wrong path' }),
        },
        {
          kind: 'content',
          content: JSON.stringify({
            kind: 'next',
            step: { name: 's1', instructions: 'do' },
          }),
        },
        {
          kind: 'content',
          content: JSON.stringify({ kind: 'done', result: 'ok' }),
        },
      ],
      executor: [{ kind: 'content', content: 'x' }],
    });
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
    const h = harness({
      evaluator: [{ kind: 'content', content: 'Goal' }],
      planner: [
        {
          kind: 'content',
          content: JSON.stringify({ kind: 'rewind', reason: 'a' }),
        },
        {
          kind: 'content',
          content: JSON.stringify({ kind: 'rewind', reason: 'b' }),
        },
      ],
      executor: [],
      config: baseConfig({ maxRewinds: 1 }),
    });
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
        {
          kind: 'content',
          content: JSON.stringify({
            kind: 'next',
            step: { name: 's1', instructions: 'd' },
          }),
        },
        {
          kind: 'content',
          content: JSON.stringify({
            kind: 'next',
            step: { name: 's2', instructions: 'd' },
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
        {
          kind: 'content',
          content: JSON.stringify({
            kind: 'next',
            step: { name: 's1', instructions: 'do' },
          }),
        },
        {
          kind: 'content',
          content: JSON.stringify({ kind: 'done', result: 'replanned-done' }),
        },
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
        {
          kind: 'content',
          content: JSON.stringify({
            kind: 'next',
            step: { name: 's1', instructions: 'do' },
          }),
        },
        {
          kind: 'content',
          content: JSON.stringify({ kind: 'done', result: 'budget-done' }),
        },
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
            kind: 'next',
            step: { name: 's1', instructions: 'do' },
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
      // Recall must restrict to artifact types (excludes 'controller-bundle').
      assert.deepEqual(opts?.filter?.artifactType, [
        'step-result',
        'mcp-result',
      ]);
      return [
        {
          content: 'INCLUDE zinc.',
          metadata: {
            traceId: 't',
            turnId: 't',
            stepperId: 'controller',
            task: 'ZINC',
            artifactType: 'mcp-result',
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
            kind: 'next',
            step: { name: 's1', instructions: 'find includes' },
          }),
        },
        {
          kind: 'content',
          content: JSON.stringify({ kind: 'done', result: 'done' }),
        },
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
            kind: 'next',
            step: { name: 's1', instructions: 'read the table' },
          }),
        },
        {
          kind: 'content',
          content: JSON.stringify({ kind: 'done', result: 'internal-done' }),
        },
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
        {
          kind: 'content',
          content: JSON.stringify({ kind: 'done', result: 'all done' }),
        },
      ],
      executor: [],
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
        {
          kind: 'content',
          content: JSON.stringify({ kind: 'done', result: 'ok' }),
        },
      ],
      executor: [],
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
            kind: 'next',
            step: { name: 's1', instructions: 'do' },
          }),
        },
        {
          kind: 'content',
          content: JSON.stringify({ kind: 'done', result: 'done' }),
        },
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
        // fenced JSON
        {
          kind: 'content',
          content:
            '```json\n{"kind":"next","step":{"name":"s1","instructions":"do"}}\n```',
        },
        // prose-wrapped JSON
        {
          kind: 'content',
          content:
            'Sure, here is my decision:\n{"kind":"done","result":"finished"}',
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
      config: { ...baseConfig(), planner: 'adaptive' },
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
    const cfg: ControllerConfig = { ...baseConfig(), planner: 'adaptive' };
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

  it('adaptive + external tool: suspend keeps cursor; resume replans with the result visible to the planner', async () => {
    const backend = new InMemoryKnowledgeBackend();
    const cfg: ControllerConfig = { ...baseConfig(), planner: 'adaptive' };
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

    // Leg 2 — resume with the result. Capture the planner replan prompt to PROVE
    // it sees the result (via plannerPrivate). Replan returns empty → finalize.
    const seenPlanner: string[] = [];
    let pCall = 0;
    const h2 = harness({
      evaluator: [],
      planner: [],
      executor: [],
      config: cfg,
    });
    h2.deps.backend = backend;
    h2.deps.planner = {
      async send(messages: Message[]) {
        const u = messages.find((m) => m.role === 'user');
        if (typeof u?.content === 'string') seenPlanner.push(u.content);
        return pCall++ === 0
          ? { kind: 'content', content: JSON.stringify({ plan: [] }) } // nothing left
          : { kind: 'content', content: 'FINAL' }; // finalize
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
      seenPlanner.some((c) => c.includes('TOOL RESULT')),
      'the planner replan saw the external tool result (via plannerPrivate)',
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

  it('adaptive external resume: malformed replan retries (resumedExternal survives) then replans', async () => {
    const backend = new InMemoryKnowledgeBackend();
    const cfg: ControllerConfig = { ...baseConfig(), planner: 'adaptive' };
    const extId = externalToolCallId('ExtTool', { q: 'x' });
    // Leg 1 — suspend on an external tool.
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
    await new ControllerCoordinatorHandler(h1.deps).execute(
      fakeCtx({
        externalTools: [{ name: 'ExtTool', description: '', inputSchema: {} }],
      }).ctx,
      {},
      undefined,
    );
    assert.equal(
      (await hydrateBundle(backend, 'sess-1')).pending?.kind,
      'external-tool',
    );

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
            kind: 'next',
            step: { name: 's1', instructions: 'do' },
          }),
        },
        {
          kind: 'content',
          content: JSON.stringify({ kind: 'done', result: 'final' }),
        },
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

  it('a judge-failure is re-asked then ABORTS the run (terminal error), not a step replan', async () => {
    const h = harness({
      evaluator: [{ kind: 'content', content: 'Goal' }],
      planner: [
        {
          kind: 'content',
          content: JSON.stringify({
            kind: 'next',
            step: { name: 's1', instructions: 'do' },
          }),
        },
        {
          kind: 'content',
          content: JSON.stringify({
            kind: 'done',
            result: 'should-not-happen',
          }),
        },
      ],
      executor: [
        { kind: 'content', content: 'result' },
        { kind: 'content', content: 'result' },
      ],
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
    assert.equal(
      reviewCalls,
      2,
      're-asked once (maxReviewRetries=1) then aborted',
    );
    assert.ok(
      captured.find(
        (c) => c.ok && /unverifiable|Error:/i.test(c.value.content),
      ),
      'surfaced a terminal error, not a replanned done',
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

  it('maxToolCalls is bounded by the durable toolCallCount, and abort is a controlFailure replan', async () => {
    const h = harness({
      evaluator: [{ kind: 'content', content: 'Goal' }],
      planner: [
        {
          kind: 'content',
          content: JSON.stringify({
            kind: 'next',
            step: { name: 's1', instructions: 'do' },
          }),
        },
        {
          kind: 'content',
          content: JSON.stringify({ kind: 'done', result: 'after-budget' }),
        },
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
        planner: 'adaptive',
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
      config: { ...baseConfig(), planner: 'adaptive' },
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
        planner: 'adaptive',
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
});
