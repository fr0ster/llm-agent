import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  externalToolCallId,
  type IKnowledgeRagHandle,
  type KnowledgeEntry,
  type LlmStreamChunk,
  type Result,
} from '@mcp-abap-adt/llm-agent';
import type { PipelineContext } from '@mcp-abap-adt/llm-agent-libs';
import { InMemoryKnowledgeBackend } from '@mcp-abap-adt/llm-agent-libs';
import {
  ControllerCoordinatorHandler,
  type ControllerHandlerDeps,
} from '../controller-coordinator-handler.js';
import { hydrateBundle } from '../session-bundle.js';
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
  const ctx = {
    sessionId: 'sess-1',
    textOrMessages: 'do the thing',
    options: undefined,
    externalResults: undefined,
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

function stubRag(): IKnowledgeRagHandle & { written: KnowledgeEntry[] } {
  const written: KnowledgeEntry[] = [];
  return {
    written,
    async query() {
      return [];
    },
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
}): Harness {
  const backend = new InMemoryKnowledgeBackend();
  const rag = stubRag();
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
    isExternalTool: opts.isExternalTool ?? (() => false),
    config: opts.config ?? baseConfig(),
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
    (h.deps.planner as ISubagentClient & { send: unknown }).send = (() => {
      let n = 0;
      return async () => {
        n++;
        return {
          kind: 'content',
          content: JSON.stringify({ kind: 'done', result: 'resumed-done' }),
        } as SubagentResult;
      };
    })();
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
});
