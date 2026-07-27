/**
 * Task 11 (#244) — end-to-end acceptance test: two MCP servers exposing a
 * COLLIDING tool name (`Search`) must both stay reachable, and a call routed
 * at the colliding (namespaced) exposed name must land on the CORRECT
 * underlying server, on the wire, with the tool's ORIGINAL (bare) name.
 *
 * Before #244, `ToolSelectHandler` / `ToolLoopHandler` deduped `listTools()`
 * results by bare name: the second server's `Search` was silently DROPPED.
 * #244 namespaces the collision instead (`s0__Search` / `s1__Search` by
 * default) and wraps the owning client (`bindToolCallName`) so every executor
 * that calls `client.callTool(exposedName, ...)` transparently reaches the
 * server with the ORIGINAL name `Search`.
 *
 * This is proven on THREE independent call-path routes, each with its own
 * spy on the two UNWRAPPED fake `IMcpClient`s (client 0 / client 1):
 *
 *   1. Full agent (`SmartAgentBuilder.build()`) — real
 *      `IMcpConnectionStrategy` + startup vectorization + a REAL lexical RAG
 *      hit (`InMemoryRag`'s bag-of-words cosine match, no embedder needed)
 *      that selects ONLY server 1's `Search`, driving the LLM's tool call
 *      through the production `ToolLoopHandler` / `executeToolBatchWithHeartbeat`
 *      executor (`tool-loop-core.ts`).
 *   2. `fireInternalToolsAsync` (`policy/mixed-tool-call-handler.ts`) — the
 *      async-fire path used when internal + external tool calls arrive
 *      together in one LLM turn.
 *   3. The coordinator's `buildCallTool` (`pipeline/handlers/coordinator.ts`,
 *      exposed as `ICoordinatorContext.callTool`) — the executor
 *      `SelfDispatch`'s inner tool-loop calls.
 *
 * Routes 2 and 3 build their `toolClientMap` with the SAME production
 * `buildNamespacedTools` used by route 1 (and by `ToolSelectHandler` /
 * `ToolLoopHandler` internally) — so all three assert the same
 * `bindToolCallName` wrapper, not three different hand-rolled maps.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildNamespacedTools,
  defaultToolNamespace,
  type ICoordinatorContext,
  type IDispatchStrategy,
  type ILlm,
  type IMcpClient,
  type IMetrics,
  InMemoryRag,
  type IPlanningStrategy,
  type LlmTool,
  type McpTool,
  NoopToolCache,
  type Plan,
  type PlanStep,
} from '@mcp-abap-adt/llm-agent';
import { SmartAgentBuilder } from '../builder.js';
import type {
  IMcpConnectionStrategy,
  McpClientDescriptor,
} from '../interfaces/mcp-connection-strategy.js';
import type { PipelineContext } from '../pipeline/context.js';
import {
  CoordinatorHandler,
  type CoordinatorHandlerDeps,
} from '../pipeline/handlers/coordinator.js';
import { ScoreThresholdToolSelection } from '../pipeline/tool-selection/index.js';
import { fireInternalToolsAsync } from '../policy/mixed-tool-call-handler.js';
import { PendingToolResultsRegistry } from '../policy/pending-tool-results-registry.js';
import type { ISpan } from '../tracer/types.js';

// ---------------------------------------------------------------------------
// Shared fake IMcpClient with a call spy — records the name/args it actually
// received on `callTool`, i.e. what reached the wire.
// ---------------------------------------------------------------------------

interface SpyMcpClient extends IMcpClient {
  calls: Array<{ name: string; args: unknown }>;
}

function makeSpySearchClient(
  description: string,
  resultContent: string,
): SpyMcpClient {
  const calls: Array<{ name: string; args: unknown }> = [];
  return {
    calls,
    async listTools() {
      return {
        ok: true as const,
        value: [{ name: 'Search', description, inputSchema: {} }] as McpTool[],
      };
    },
    async callTool(name: string, args: unknown) {
      calls.push({ name, args });
      return { ok: true as const, value: { content: resultContent } };
    },
  } as SpyMcpClient;
}

function makeSpan(): ISpan {
  return {
    name: 's',
    setAttribute() {},
    setStatus() {},
    addEvent() {},
    end() {},
  } as unknown as ISpan;
}

// ---------------------------------------------------------------------------
// Route 1 — full agent: RAG-driven selection → LLM tool call → tool-loop executor
// ---------------------------------------------------------------------------

test('#244 e2e — route 1 (tool-loop executor): a RAG hit for server 1s Search drives a tool call that reaches client 1 with the original name, and client 0 is never called', async () => {
  const client0 = makeSpySearchClient(
    'Executes ledger reconciliation lookups against the finance database schema.',
    'db-result',
  );
  const client1 = makeSpySearchClient(
    'Retrieves realtime hurricane temperature forecast readings from remote weather stations.',
    'weather-result',
  );
  const descriptors: McpClientDescriptor[] = [
    { slotIndex: 0 },
    { slotIndex: 1 },
  ];
  const connectionStrategy: IMcpConnectionStrategy = {
    async resolve() {
      return {
        clients: [client0, client1],
        toolsChanged: true,
        clientDescriptors: descriptors,
        configuredSlotCount: 2,
      };
    },
  };
  const toolsRag = new InMemoryRag();

  // Records exactly which exposed tool name(s) the LLM was OFFERED on the
  // first turn — this is the "RAG hit / selection" half of the proof: only
  // the exposed name for server 1's Search must have survived the
  // ScoreThresholdToolSelection filter (client 0's description shares no
  // token with the query, so it scores exactly 0 and is filtered out).
  let offeredOnFirstTurn: string[] = [];
  let turn = 0;
  const mainLlm: ILlm = {
    model: 'stub',
    async chat() {
      return {
        ok: true as const,
        value: { content: 'done', finishReason: 'stop' as const },
      };
    },
    async *streamChat(_messages, tools) {
      turn++;
      if (turn === 1) {
        offeredOnFirstTurn = tools.map((t) => t.name);
        const chosen = tools[0]?.name ?? 's1__Search';
        yield {
          ok: true as const,
          value: {
            content: '',
            toolCalls: [
              {
                index: 0,
                id: 'tc_1',
                name: chosen,
                arguments: '{"q":"hurricane"}',
              },
            ],
            finishReason: 'tool_calls' as const,
          },
        };
      } else {
        yield {
          ok: true as const,
          value: { content: 'done', finishReason: 'stop' as const },
        };
      }
    },
  };

  const handle = await new SmartAgentBuilder()
    .withMainLlm(mainLlm)
    .withMcpConnectionStrategy(connectionStrategy)
    .setToolsRag(toolsRag)
    // A minimal positive threshold: client 0's description shares NO token
    // with the query below, so it scores exactly 0.0 and is dropped; client
    // 1's matches on "hurricane"/"temperature"/"forecast" and scores > 0.
    .withToolSelectionStrategy(new ScoreThresholdToolSelection(0.0001))
    .withMode('smart')
    .withClassification(false)
    .build();

  const res = await handle.agent.process('hurricane temperature forecast');
  assert.equal(res.ok, true, 'process() must complete successfully');

  assert.deepEqual(
    offeredOnFirstTurn,
    ['s1__Search'],
    'the RAG hit must select ONLY the exposed name for server 1s Search tool',
  );

  assert.equal(
    client1.calls.length,
    1,
    'client 1 (owner of the RAG-selected Search tool) must be called exactly once',
  );
  assert.equal(
    client1.calls[0]?.name,
    'Search',
    'bindToolCallName must unwrap the namespaced exposed name back to the ORIGINAL name on the wire',
  );
  assert.equal(
    client0.calls.length,
    0,
    'client 0 must NEVER be called — routing must not cross to the wrong server',
  );
});

// ---------------------------------------------------------------------------
// Route 2 — mixed-tool-call-handler.fireInternalToolsAsync
// ---------------------------------------------------------------------------

test('#244 e2e — route 2 (fireInternalToolsAsync): the mixed internal/external async path sends the original name to client 1, never client 0', async () => {
  const client0 = makeSpySearchClient('server 0 search tool', 'db-result');
  const client1 = makeSpySearchClient('server 1 search tool', 'weather-result');

  const { toolClientMap } = buildNamespacedTools(
    [
      { slotIndex: 0, client: client0, tools: [{ name: 'Search' } as McpTool] },
      { slotIndex: 1, client: client1, tools: [{ name: 'Search' } as McpTool] },
    ],
    defaultToolNamespace,
  );
  assert.deepEqual(
    [...toolClientMap.keys()].sort(),
    ['s0__Search', 's1__Search'],
    'sanity: buildNamespacedTools must namespace the collision (s0/s1 prefixes)',
  );

  const registry = new PendingToolResultsRegistry();
  const metrics = { toolCallCount: { add() {} } } as unknown as IMetrics;

  fireInternalToolsAsync(
    'calling search',
    [{ id: 'tc_1', name: 's1__Search', arguments: { q: 'hurricane' } }],
    registry,
    'session-mixed',
    {
      toolClientMap,
      toolCache: new NoopToolCache(),
      metrics,
      options: undefined,
    },
  );

  const consumed = await registry.consume('session-mixed');
  assert.ok(consumed, 'the pending entry must resolve');
  assert.equal(consumed?.results[0]?.toolName, 's1__Search');
  assert.equal(consumed?.results[0]?.text, 'weather-result');

  assert.equal(
    client1.calls.length,
    1,
    'client 1 must receive exactly one callTool via the async internal-fire path',
  );
  assert.equal(
    client1.calls[0]?.name,
    'Search',
    'the wrapper must unwrap s1__Search back to the ORIGINAL name Search on the wire',
  );
  assert.equal(
    client0.calls.length,
    0,
    'client 0 must NOT be called by the mixed-tool-call-handler path',
  );
});

// ---------------------------------------------------------------------------
// Route 3 — coordinator buildCallTool (ICoordinatorContext.callTool)
// ---------------------------------------------------------------------------

test('#244 e2e — route 3 (coordinator buildCallTool / SelfDispatch executor): ctx.callTool sends the original name to client 1, never client 0', async () => {
  const client0 = makeSpySearchClient('server 0 search tool', 'db-result');
  const client1 = makeSpySearchClient('server 1 search tool', 'weather-result');

  const { toolClientMap } = buildNamespacedTools(
    [
      { slotIndex: 0, client: client0, tools: [{ name: 'Search' } as McpTool] },
      { slotIndex: 1, client: client1, tools: [{ name: 'Search' } as McpTool] },
    ],
    defaultToolNamespace,
  );

  // A minimal PipelineContext stub — mirrors the pattern already used by
  // pipeline/handlers/__tests__/coordinator.test.ts's makeCtx(): only the
  // fields CoordinatorHandler.execute() actually reads/writes.
  const chunks: Array<{ content?: string; finishReason?: string }> = [];
  const ctx = {
    inputText: 'search for the forecast',
    sessionId: 'session-coordinator',
    assembledMessages: [],
    options: undefined,
    toolClientMap,
    activeTools: [{ name: 's1__Search' }] as unknown as LlmTool[],
    yield(chunk: {
      ok: boolean;
      value?: { content?: string; finishReason?: string };
    }) {
      if (chunk.ok && chunk.value) chunks.push(chunk.value);
    },
  } as unknown as PipelineContext;

  // Captures the SAME ctx.callTool (built by buildCallTool(ctx) inside
  // CoordinatorHandler.execute) that SelfDispatch's inner tool-loop uses —
  // exercised directly here to isolate route 3 from routes 1/2.
  let capturedResult: string | undefined;
  const dispatch: IDispatchStrategy = {
    name: 'capture-call-tool',
    async dispatch(step, coordCtx: ICoordinatorContext) {
      assert.equal(
        typeof coordCtx.callTool,
        'function',
        'CoordinatorHandler must build ctx.callTool from a non-empty toolClientMap',
      );
      capturedResult = await coordCtx.callTool?.('s1__Search', {
        q: 'hurricane',
      });
      return {
        stepId: step.id,
        output: capturedResult ?? '',
        durationMs: 1,
        ok: true,
      };
    },
  };
  const planning: IPlanningStrategy = {
    name: 'fake-planning',
    async buildInitialPlan(): Promise<Plan> {
      const step: PlanStep = { id: 's1', goal: 'search', status: 'pending' };
      return {
        steps: [step],
        rationale: 'test',
        createdAt: Date.now(),
        source: 'planner-llm',
      };
    },
    shouldReplan() {
      return false;
    },
    async rebuildPlan(): Promise<Plan> {
      return {
        steps: [],
        rationale: '',
        createdAt: Date.now(),
        source: 'planner-llm',
      };
    },
  };
  const deps: CoordinatorHandlerDeps = {
    planning,
    dispatch,
    maxSteps: 8,
    maxRetriesPerStep: 0,
    failPolicy: 'abort',
  };

  const ok = await new CoordinatorHandler(deps).execute(ctx, {}, makeSpan());
  assert.equal(ok, true, 'CoordinatorHandler.execute must complete cleanly');
  assert.equal(capturedResult, 'weather-result');
  assert.ok(chunks.some((c) => c.finishReason === 'stop'));

  assert.equal(
    client1.calls.length,
    1,
    'client 1 must receive exactly one callTool via ctx.callTool (buildCallTool)',
  );
  assert.equal(
    client1.calls[0]?.name,
    'Search',
    'buildCallTool must route through the wrapper, unwrapping s1__Search back to Search',
  );
  assert.equal(
    client0.calls.length,
    0,
    'client 0 must NOT be called by the coordinator callTool executor',
  );
});
