/**
 * Task 11: the controller `runStep` loop forms its per-round executor context via
 * an injected `IToolLoopContextStrategy` (record/form) instead of pushing raw tool
 * results into a single growing `messages` array. With a `WindowContextStrategy`
 * factory injected, the per-round executor context stays bounded as the number of
 * tool calls grows; the most-recent assistant+tool pair is always the tail; a
 * tool-level result round is recorded; and control retries live in
 * `inFlightStep.controlTail` (persisted, present in the next form, pruned after the
 * next recorded round).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  IKnowledgeRagHandle,
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
  WindowContextStrategy,
} from '@mcp-abap-adt/llm-agent-libs';
import {
  ControllerCoordinatorHandler,
  type ControllerHandlerDeps,
} from '../controller-coordinator-handler.js';
import { hydrateBundle } from '../session-bundle.js';
import type { ISubagentClient } from '../subagent-client.js';
import type { ControllerConfig, SubagentResult } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers (mirror controller-mcp-failloud.test.ts)
// ---------------------------------------------------------------------------

type Captured = Result<LlmStreamChunk, unknown>;

function fakeCtx(overrides: Partial<PipelineContext> = {}): {
  ctx: PipelineContext;
  captured: Captured[];
} {
  const captured: Captured[] = [];
  const requestLogger = new SessionRequestLogger();
  requestLogger.startRequest('sess-ctx');
  const ctx = {
    sessionId: 'sess-ctx',
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
  toolCalls: [{ id: `c-${JSON.stringify(args)}`, name, arguments: args }],
});

/** Records the messages the executor was asked to send each round. */
function recordingExecutor(queue: SubagentResult[]): {
  client: ISubagentClient;
  rounds: Message[][];
} {
  const rounds: Message[][] = [];
  return {
    rounds,
    client: {
      async send(messages: Message[]) {
        rounds.push(messages);
        const next = queue.shift();
        if (!next) return { kind: 'content', content: '' };
        return next;
      },
    },
  };
}

const KEEP = 3;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('controller runStep — per-round context strategy (Task 11)', () => {
  it('(a) flatness: per-round executor messages stay bounded as K tool calls grow', async () => {
    const backend = new InMemoryKnowledgeBackend();
    const rag = stubRag();
    const K = 8;

    const execQueue: SubagentResult[] = [
      ...Array.from({ length: K }, (_, i) => toolCall('GetData', { i })),
      { kind: 'content', content: 'final answer' },
    ];
    const exec = recordingExecutor(execQueue);

    const deps: ControllerHandlerDeps = {
      evaluator: scriptedClient([{ kind: 'content', content: 'Goal: do it' }]),
      planner: scriptedClient([
        {
          kind: 'content',
          content: JSON.stringify({
            plan: [{ name: 's1', instructions: 'gather data' }],
          }),
        },
        { kind: 'content', content: 'FINAL' },
      ]),
      executor: exec.client,
      backend,
      knowledgeRagFor: () => rag,
      embedder: stubEmbedder,
      callMcp: async (_n, args) => `RESULT-${JSON.stringify(args)}`,
      selectTools: async (): Promise<LlmTool[]> => [
        { name: 'GetData', description: '', inputSchema: {} },
      ],
      isExternalTool: () => false,
      config: baseConfig(),
      models: { evaluator: 'm', planner: 'm', executor: 'm' },
      toolLoopContextStrategyFactory: () =>
        new WindowContextStrategy({ keepLastRounds: KEEP }),
    };

    const handler = new ControllerCoordinatorHandler(deps);
    const { ctx } = fakeCtx();
    await handler.execute(ctx, {}, undefined);

    // K tool rounds + 1 final content ⇒ K+1 executor sends.
    assert.equal(exec.rounds.length, K + 1);
    const last = exec.rounds[K]?.length ?? 0; // after K recorded rounds
    const prefixLen = exec.rounds[0]?.length ?? 0; // static prefix, no rounds yet
    // Hard cap: prefix + one elision marker + KEEP rounds × 2 messages — CONSTANT,
    // independent of K. A raw-accumulating loop would instead grow to
    // prefix + K × 2 messages, so as K grows the window stays flat.
    const windowCap = prefixLen + 1 + KEEP * 2;
    assert.ok(
      last <= windowCap,
      `round[K]=${last} exceeded window cap ${windowCap}`,
    );
    // Strictly below what raw accumulation would produce for this K.
    const rawWouldBe = prefixLen + K * 2;
    assert.ok(
      last < rawWouldBe,
      `window did not bound growth: round[K]=${last}, raw would be ${rawWouldBe}`,
    );
  });

  it('(b) tail is always the most-recent assistant+tool pair', async () => {
    const backend = new InMemoryKnowledgeBackend();
    const rag = stubRag();
    const K = 5;

    const execQueue: SubagentResult[] = [
      ...Array.from({ length: K }, (_, i) => toolCall('GetData', { i })),
      { kind: 'content', content: 'done' },
    ];
    const exec = recordingExecutor(execQueue);

    const deps: ControllerHandlerDeps = {
      evaluator: scriptedClient([{ kind: 'content', content: 'Goal: do it' }]),
      planner: scriptedClient([
        {
          kind: 'content',
          content: JSON.stringify({
            plan: [{ name: 's1', instructions: 'gather' }],
          }),
        },
        { kind: 'content', content: 'FINAL' },
      ]),
      executor: exec.client,
      backend,
      knowledgeRagFor: () => rag,
      embedder: stubEmbedder,
      callMcp: async (_n, args) => `RESULT-${JSON.stringify(args)}`,
      selectTools: async (): Promise<LlmTool[]> => [
        { name: 'GetData', description: '', inputSchema: {} },
      ],
      isExternalTool: () => false,
      config: baseConfig(),
      models: { evaluator: 'm', planner: 'm', executor: 'm' },
      toolLoopContextStrategyFactory: () =>
        new WindowContextStrategy({ keepLastRounds: KEEP }),
    };

    const handler = new ControllerCoordinatorHandler(deps);
    const { ctx } = fakeCtx();
    await handler.execute(ctx, {}, undefined);

    // On the send after round i (1..K), the last two messages are the assistant
    // tool_call for i-1 and its tool result RESULT-{"i":i-1}.
    for (let round = 1; round <= K; round++) {
      const msgs = exec.rounds[round];
      assert.ok(msgs, `missing executor messages for round ${round}`);
      const tool = msgs[msgs.length - 1];
      const assistant = msgs[msgs.length - 2];
      assert.equal(
        tool?.role,
        'tool',
        `round ${round}: tail is a tool message`,
      );
      assert.equal(
        assistant?.role,
        'assistant',
        `round ${round}: penultimate is the assistant tool_call`,
      );
      assert.equal(
        tool?.content,
        `RESULT-${JSON.stringify({ i: round - 1 })}`,
        `round ${round}: tail carries the most-recent result`,
      );
    }
  });

  it('(c) a tool-level result round is recorded and present in the next form()', async () => {
    const backend = new InMemoryKnowledgeBackend();
    const rag = stubRag();

    const exec = recordingExecutor([
      toolCall('ErrTool', { q: 1 }),
      { kind: 'content', content: 'handled the error' },
    ]);

    const deps: ControllerHandlerDeps = {
      evaluator: scriptedClient([{ kind: 'content', content: 'Goal: do it' }]),
      planner: scriptedClient([
        {
          kind: 'content',
          content: JSON.stringify({
            plan: [{ name: 's1', instructions: 'try' }],
          }),
        },
        { kind: 'content', content: 'FINAL' },
      ]),
      executor: exec.client,
      backend,
      knowledgeRagFor: () => rag,
      embedder: stubEmbedder,
      callMcp: async () => 'ERROR: table not found',
      selectTools: async (): Promise<LlmTool[]> => [
        { name: 'ErrTool', description: '', inputSchema: {} },
      ],
      isExternalTool: () => false,
      config: baseConfig(),
      models: { evaluator: 'm', planner: 'm', executor: 'm' },
      toolLoopContextStrategyFactory: () =>
        new WindowContextStrategy({ keepLastRounds: KEEP }),
    };

    const handler = new ControllerCoordinatorHandler(deps);
    const { ctx } = fakeCtx();
    await handler.execute(ctx, {}, undefined);

    // The round with the tool-level error string was recorded → the executor's
    // NEXT send (round index 1) surfaces it.
    const next = exec.rounds[1] ?? [];
    assert.ok(
      next.some(
        (m) =>
          typeof m.content === 'string' &&
          m.content.includes('ERROR: table not found'),
      ),
      'the tool-level error round must be present in the next form()',
    );
  });

  it('(d) controlTail: a retry message is stored on inFlightStep, re-emitted, persisted, then pruned', async () => {
    const backend = new InMemoryKnowledgeBackend();
    const rag = stubRag();

    // Round 0: hallucinated (unavailable) tool → retry into controlTail.
    // Round 1: valid tool call → a recorded round prunes the controlTail.
    // Round 2: content → finish.
    const execQueue: SubagentResult[] = [
      toolCall('NopeTool', { x: 1 }), // not offered → retry
      toolCall('GetData', { i: 0 }), // valid → recorded round
      { kind: 'content', content: 'done' },
    ];
    const rounds: Message[][] = [];
    const persistedTail: number[] = [];
    const executor: ISubagentClient = {
      async send(messages: Message[]) {
        rounds.push(messages);
        // Inspect the PERSISTED bundle to prove controlTail durability.
        const b = await hydrateBundle(backend, 'sess-ctx');
        persistedTail.push(b.inFlightStep?.controlTail?.length ?? 0);
        const next = execQueue.shift();
        if (!next) return { kind: 'content', content: '' };
        return next;
      },
    };

    const RETRY_MARK = 'is not available for this step';

    const deps: ControllerHandlerDeps = {
      evaluator: scriptedClient([{ kind: 'content', content: 'Goal: do it' }]),
      planner: scriptedClient([
        {
          kind: 'content',
          content: JSON.stringify({
            plan: [{ name: 's1', instructions: 'gather' }],
          }),
        },
        { kind: 'content', content: 'FINAL' },
      ]),
      executor,
      backend,
      knowledgeRagFor: () => rag,
      embedder: stubEmbedder,
      callMcp: async (_n, args) => `RESULT-${JSON.stringify(args)}`,
      selectTools: async (): Promise<LlmTool[]> => [
        { name: 'GetData', description: '', inputSchema: {} },
      ],
      isExternalTool: () => false,
      config: baseConfig(),
      models: { evaluator: 'm', planner: 'm', executor: 'm' },
      toolLoopContextStrategyFactory: () =>
        new WindowContextStrategy({ keepLastRounds: KEEP }),
    };

    const handler = new ControllerCoordinatorHandler(deps);
    const { ctx } = fakeCtx();
    await handler.execute(ctx, {}, undefined);

    // Three executor sends: initial, after-retry, after-valid-round.
    assert.equal(rounds.length, 3);

    // (d1) present in the NEXT executor messages after the retry (round index 1).
    assert.ok(
      rounds[1]?.some(
        (m) => typeof m.content === 'string' && m.content.includes(RETRY_MARK),
      ),
      'the retry message must be present in the next form() (via controlTail)',
    );

    // (d1') persisted on the bundle at the time of that send.
    assert.equal(
      persistedTail[1],
      1,
      'controlTail must be persisted (length 1) when the retry is live',
    );

    // (d2) pruned after the next recorded round → gone from the following send.
    assert.ok(
      !rounds[2]?.some(
        (m) => typeof m.content === 'string' && m.content.includes(RETRY_MARK),
      ),
      'the retry message must be pruned once the next round is recorded',
    );
    assert.equal(
      persistedTail[2],
      0,
      'controlTail must be pruned (length 0) after the recorded round',
    );
  });
});
