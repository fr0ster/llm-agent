/**
 * #244 Task 8 — routing wiring. Namespaced MCP calls (`s1__Search`) must reach
 * the client that actually owns them, on ALL affected pipelines, with #213
 * per-session isolation and MCP fail-loud preserved:
 *
 *   - `SmartServer.buildServerCtx` populates a PER-SESSION `ctx.toolClientMap`
 *     by rebinding the authoritative snapshot's provenance (`_toolProvenance`)
 *     onto `scope.parts.mcpClients` + `scope.parts.mcpClientDescriptors` —
 *     pairing by `slotIndex`, never array index (#213 isolation: session
 *     clients are FRESH instances, never the server's global
 *     `_sharedMcpClients`).
 *   - `SmartServer.callMcp` (the linear/stepper `ctx.callMcp` bridge) rebinds
 *     the SAME provenance onto the GLOBAL `_sharedMcpClients` +
 *     `_sharedMcpClientDescriptors` and dispatches through the shared
 *     namespaced bridge.
 *   - `ControllerPipelinePlugin.build` consumes `ctx.toolClientMap` (when
 *     present) via `buildNamespacedMcpBridge` instead of building its own
 *     bare `buildMcpBridge(ctx.mcpClients, …)` scan.
 *
 * Both bridges share the SAME fail-loud contract: an MCP_UNAVAILABLE_CODES
 * error THROWS (never `isError`, never a swallowed "Tool not found").
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type ILlm,
  type IMcpClient,
  type LlmResponse,
  type LlmTool,
  type McpClientDescriptor,
  McpError,
  type Result,
} from '@mcp-abap-adt/llm-agent';
import {
  InMemoryKnowledgeBackend,
  type SessionAgentParts,
  SessionRequestLogger,
} from '@mcp-abap-adt/llm-agent-libs';
import { fakeControllerServerCtx } from '../../pipelines/__tests__/fixtures.js';
import { ControllerPipelinePlugin } from '../../pipelines/controller.js';
import type { IServerPipelineContext } from '../../pipelines/server-context.js';
import { makeKnowledgeSemanticIndex } from '../../smart-agent/embedder-knowledge-index.js';
import { SmartServer } from '../smart-server.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface RecordedCall {
  client: string;
  name: string;
}

function recordingMcpClient(
  id: string,
  tools: string[],
  calls: RecordedCall[],
  opts?: { failError?: McpError },
): IMcpClient {
  return {
    async listTools() {
      return {
        ok: true as const,
        value: tools.map((name) => ({
          name,
          description: `Tool ${name}`,
          inputSchema: { type: 'object', properties: {} },
        })),
      };
    },
    async callTool(name: string) {
      calls.push({ client: id, name });
      if (opts?.failError) {
        return { ok: false as const, error: opts.failError };
      }
      return { ok: true as const, value: { content: `ok-from-${id}` } };
    },
    async healthCheck() {
      return { ok: true as const, value: !opts?.failError };
    },
  } as IMcpClient;
}

/** Reach the private routing surfaces without changing visibility. */
interface ServerInternals {
  buildServerCtx(scope: {
    sessionId: string;
    parts: SessionAgentParts;
  }): Promise<IServerPipelineContext>;
  callMcp(
    name: string,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<{ text: string; isError: boolean }>;
  _workers?: unknown;
  _stepperKnowledgeBackend?: unknown;
  _toolProvenance?: ReadonlyMap<
    string,
    { slotIndex: number; originalName: string }
  >;
  _sharedMcpClients?: IMcpClient[];
  _sharedMcpClientDescriptors?: readonly McpClientDescriptor[];
}

function makeBareServer(): ServerInternals {
  const server = new SmartServer({}) as unknown as ServerInternals;
  server._workers = { build: async () => new Map() };
  server._stepperKnowledgeBackend = new InMemoryKnowledgeBackend();
  return server;
}

function fakeSessionScope(
  sessionId: string,
  mcpClients: IMcpClient[],
  mcpClientDescriptors: readonly McpClientDescriptor[],
): { sessionId: string; parts: SessionAgentParts } {
  return {
    sessionId,
    parts: {
      sessionId,
      mcpClients,
      mcpClientDescriptors,
      toolsRag: undefined,
      ragRegistry: {} as never,
      logger: new SessionRequestLogger(),
    },
  };
}

// Non-zero constant embedder so goal/prompt semantic distance is 0 (target-state
// established) — mirrors controller-mcp-classifier.test.ts's gate-bypass trick.
const constEmbedder = {
  embed: async () => ({ vector: [1, 0, 0] }),
  dimensions: 3,
} as unknown as import('@mcp-abap-adt/llm-agent').IEmbedder;

function scriptedLlm(model: string, queue: Partial<LlmResponse>[]): ILlm {
  return {
    model,
    chat: async (): Promise<Result<LlmResponse, never>> => {
      const next = queue.shift() ?? { content: '' };
      return {
        ok: true,
        value: { content: '', toolCalls: [], ...next } as LlmResponse,
      };
    },
    streamChat: async function* () {},
  } as unknown as ILlm;
}

const SEARCH_TOOL = (name: string): LlmTool =>
  ({
    name,
    description: 'search',
    inputSchema: { type: 'object' },
  }) as unknown as LlmTool;

async function runController(
  ctx: Parameters<ControllerPipelinePlugin['build']>[1],
  calledToolName: string,
): Promise<void> {
  const byModel: Record<string, ILlm> = {
    'm-eval': scriptedLlm('m-eval', [{ content: 'Goal: search stuff' }]),
    'm-plan': scriptedLlm('m-plan', [
      {
        content: JSON.stringify({
          plan: [{ name: 's1', instructions: 'search' }],
        }),
      },
      { content: 'done' },
    ]),
    'm-exec': scriptedLlm('m-exec', [
      {
        toolCalls: [{ id: 'c1', name: calledToolName, arguments: { q: 'x' } }],
      },
      { content: 'result' },
    ]),
  };

  const plugin = new ControllerPipelinePlugin('controller', 'smart-executor');
  const cfg = plugin.parseConfig({
    subagents: {
      evaluator: { provider: 'openai', model: 'm-eval' },
      planner: { provider: 'openai', model: 'm-plan' },
      executor: { provider: 'openai', model: 'm-exec' },
    },
  });

  const fullCtx = {
    ...ctx,
    makeLlm: async (c: { model?: string }) =>
      byModel[c.model ?? ''] ?? (ctx as { mainLlm: ILlm }).mainLlm,
  } as unknown as Parameters<typeof plugin.build>[1];

  const inst = await plugin.build(cfg, fullCtx);
  try {
    for await (const chunk of inst.agent.streamProcess('search stuff')) {
      void chunk;
    }
  } finally {
    await inst.close();
  }
}

// ---------------------------------------------------------------------------
// 1. Controller session-local: s1__Search reaches the SESSION's client-1,
//    never the server's global _sharedMcpClients.
// ---------------------------------------------------------------------------

test('controller session-local: s1__Search routes to the SESSION client-1 instance (not the global _sharedMcpClients), original name Search on the wire', async () => {
  const calls: RecordedCall[] = [];
  const sessionClient0 = recordingMcpClient('session0', ['Search'], calls);
  const sessionClient1 = recordingMcpClient('session1', ['Search'], calls);
  const globalClient0 = recordingMcpClient('global0', ['Search'], calls);
  const globalClient1 = recordingMcpClient('global1', ['Search'], calls);

  const server = makeBareServer();
  // Authoritative snapshot: s1__Search collides at slot 1.
  server._toolProvenance = new Map([
    ['s1__Search', { slotIndex: 1, originalName: 'Search' }],
  ]);
  // The GLOBAL registry deliberately holds DIFFERENT client instances — proves
  // the session ctx never falls back to it.
  server._sharedMcpClients = [globalClient0, globalClient1];
  server._sharedMcpClientDescriptors = [{ slotIndex: 0 }, { slotIndex: 1 }];

  const scope = fakeSessionScope(
    'sess-a',
    [sessionClient0, sessionClient1],
    [{ slotIndex: 0 }, { slotIndex: 1 }],
  );
  const serverCtx = await server.buildServerCtx(scope);
  assert.ok(
    serverCtx.toolClientMap,
    'ctx.toolClientMap must be populated when the snapshot has provenance',
  );

  const base = fakeControllerServerCtx();
  const ctx = {
    ...base,
    embedder: constEmbedder,
    stepperKnowledgeBackend: new InMemoryKnowledgeBackend(
      makeKnowledgeSemanticIndex(constEmbedder),
    ),
    knowledgeRagFor: () => ({
      query: async () => [],
      list: async () => [],
      write: async () => {},
      fingerprint: () => 'stub',
    }),
    toolsRag: {
      query: async () => [SEARCH_TOOL('s1__Search')],
      lookup: () => undefined,
    },
    // A DIFFERENT (wrong) global set on ctx.mcpClients — only reached by the
    // FALLBACK bridge, never by a correctly-namespaced dispatch.
    mcpClients: [globalClient0, globalClient1],
    toolClientMap: serverCtx.toolClientMap,
  };

  await runController(
    ctx as unknown as Parameters<ControllerPipelinePlugin['build']>[1],
    's1__Search',
  );

  assert.ok(
    calls.some((c) => c.client === 'session1' && c.name === 'Search'),
    `expected the SESSION client-1 to receive a call with original name Search; got ${JSON.stringify(calls)}`,
  );
  assert.ok(
    !calls.some((c) => c.client === 'global1'),
    'the GLOBAL _sharedMcpClients client-1 must NOT receive the call',
  );
  assert.ok(
    !calls.some((c) => c.client === 'session0'),
    'the wrong session slot (0) must not receive the call',
  );
});

// ---------------------------------------------------------------------------
// 2. callMcp (linear/stepper): ctx.callMcp('s1__Search', …) reaches server 1
//    with the original name Search.
// ---------------------------------------------------------------------------

test('callMcp: s1__Search reaches server 1 with original name Search', async () => {
  const calls: RecordedCall[] = [];
  const client0 = recordingMcpClient('g0', ['Search'], calls);
  const client1 = recordingMcpClient('g1', ['Search'], calls);

  const server = makeBareServer();
  server._toolProvenance = new Map([
    ['s1__Search', { slotIndex: 1, originalName: 'Search' }],
  ]);
  server._sharedMcpClients = [client0, client1];
  server._sharedMcpClientDescriptors = [{ slotIndex: 0 }, { slotIndex: 1 }];

  const result = await server.callMcp('s1__Search', { q: 'x' });

  assert.equal(result.isError, false);
  assert.deepEqual(calls, [{ client: 'g1', name: 'Search' }]);
});

// ---------------------------------------------------------------------------
// 3. Filtered-global routing (P1 regression guard): active slots [0,2] —
//    s2__Search must route to the slot-2 client, proving rebind uses
//    slotIndex from descriptors, NOT array index.
// ---------------------------------------------------------------------------

test('filtered-global routing: active slots [0,2], s2__Search routes to the slot-2 client by slotIndex (not array index)', async () => {
  const calls: RecordedCall[] = [];
  // Slot 1 is INACTIVE (filtered out) — the array holds only slots 0 and 2,
  // at array indices 0 and 1 respectively.
  const clientSlot0 = recordingMcpClient('slot0', ['Search'], calls);
  const clientSlot2 = recordingMcpClient('slot2', ['Search'], calls);

  const server = makeBareServer();
  server._toolProvenance = new Map([
    ['s2__Search', { slotIndex: 2, originalName: 'Search' }],
  ]);
  server._sharedMcpClients = [clientSlot0, clientSlot2];
  server._sharedMcpClientDescriptors = [{ slotIndex: 0 }, { slotIndex: 2 }];

  const result = await server.callMcp('s2__Search', {});

  assert.equal(result.isError, false);
  assert.deepEqual(
    calls,
    [{ client: 'slot2', name: 'Search' }],
    'array-index rebind (index 2) would miss entirely; slotIndex rebind correctly hits the slot-2 client at array index 1',
  );
});

// ---------------------------------------------------------------------------
// 4. Down-server fail-loud: server 1's client is present in the session but
//    unavailable → s1__Search THROWS (classifier availability), not isError,
//    not "Tool not found".
// ---------------------------------------------------------------------------

test('down-server fail-loud: s1__Search THROWS when server 1 is unavailable (not isError, not Tool not found)', async () => {
  const calls: RecordedCall[] = [];
  const client0 = recordingMcpClient('g0', ['Search'], calls);
  const downClient1 = recordingMcpClient('g1', ['Search'], calls, {
    failError: new McpError('server down', 'MCP_NOT_CONNECTED'),
  });

  const server = makeBareServer();
  server._toolProvenance = new Map([
    ['s1__Search', { slotIndex: 1, originalName: 'Search' }],
  ]);
  server._sharedMcpClients = [client0, downClient1];
  server._sharedMcpClientDescriptors = [{ slotIndex: 0 }, { slotIndex: 1 }];

  await assert.rejects(
    () => server.callMcp('s1__Search', {}),
    (err: unknown) => {
      assert.ok(err instanceof McpError, 'must throw the classified McpError');
      assert.equal((err as McpError).code, 'MCP_NOT_CONNECTED');
      return true;
    },
  );
});
