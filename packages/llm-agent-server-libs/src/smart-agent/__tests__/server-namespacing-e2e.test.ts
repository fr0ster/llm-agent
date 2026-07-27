/**
 * #244 Task 9 — end-to-end acceptance: two REAL (in-process, real sockets)
 * MCP servers exposing the SAME tool name (`Search`) must both stay
 * reachable through the SERVER pipelines (controller / stepper / linear),
 * with #213 per-session isolation and MCP fail-loud preserved, driven
 * through a genuinely BOOTED `SmartServer` — real `server.start()` /
 * `_buildEmbeddedAgent()`, real network `tools/list` + `tools/call`, real
 * per-session client construction (`buildSessionMcpClients`) — not manually
 * injected `_toolProvenance`/`_sharedMcpClients` state.
 *
 * Coverage map (see the task-9 report for the full rationale):
 *   - Session-availability + fail-loud (throw vs isError vs "Tool not
 *     found") + no-writable-RAG deployment: THIS FILE (test 1).
 *   - Per-session isolation (#213) with real per-session client instances:
 *     THIS FILE (test 2).
 *   - `mcp[].name` labels on the yaml-builder path, the default
 *     `connectMcpClientsWithDescriptorsFromConfig` connector (over a REAL
 *     live transport — closing a gap `stepper-mcp-from-config.test.ts`
 *     explicitly deferred), and the bare-`connectMcp` fallback: THIS FILE
 *     (tests 3-5).
 *   - Controller (session `ctx.toolClientMap`) AND stepper (global
 *     `callMcp`) routing server-1's `Search` to client 1 with the ORIGINAL
 *     name, through the REAL production coordinator/executor runtime, over
 *     REAL booted state: THIS FILE (tests 6-7).
 *   - Stale/foreign RAG record skipped: ALREADY covered at the appropriate
 *     (sufficient, deterministic) level by
 *     `tools-rag-handle-namespace.test.ts` (Task 5) — the mechanism lives
 *     entirely inside the pure `makeToolsRagHandle` catalog lookup, so a
 *     pipeline-level re-test would add setup cost without adding coverage.
 *     NOT duplicated here.
 *   - Partial `listTools()` failure drops only the failing server (logged):
 *     ALREADY covered by `server-namespace-snapshot.test.ts` (Task 6, test
 *     "fallback build: middle-client listTools() failure keeps the
 *     surviving third client at slotIndex 2"). NOT duplicated here.
 *   - The routing WIRING itself (`buildServerCtx`/`callMcp`/controller
 *     consuming `ctx.toolClientMap`) is already unit-proven by
 *     `server-routing-namespace.test.ts` (Task 8) with manually-injected
 *     `_toolProvenance`/`_sharedMcpClients`. This file adds the missing
 *     ingredient: the SAME routes exercised over GENUINELY booted state.
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import {
  buildNamespacedTools,
  defaultToolNamespace,
  type ILlm,
  type IMcpClient,
  isMcpUnavailable,
  type LlmResponse,
  type LlmTool,
  McpError,
  type McpTool,
  TokenLedger,
} from '@mcp-abap-adt/llm-agent';
import {
  InMemoryKnowledgeBackend,
  KnowledgeRag,
  type SessionAgentParts,
  SessionRequestLogger,
} from '@mcp-abap-adt/llm-agent-libs';
import { fakeControllerServerCtx } from '../../pipelines/__tests__/fixtures.js';
import { ControllerPipelinePlugin } from '../../pipelines/controller.js';
import type { IServerPipelineContext } from '../../pipelines/server-context.js';
import { buildStepperRoot } from '../build-stepper-root.js';
import { makeKnowledgeSemanticIndex } from '../embedder-knowledge-index.js';
import { buildSessionMcpClients } from '../mcp/build-session-mcp-clients.js';
import { buildNamespacedMcpBridge } from '../mcp/namespaced-bridge.js';
import {
  connectMcpClientsWithDescriptorsFromConfig,
  SmartServer,
  type SmartServerMcpConfig,
} from '../smart-server.js';

// ---------------------------------------------------------------------------
// A REAL in-process MCP streamable-HTTP stub (hermetic — no SDK, no spawn).
// Handshake: `initialize`, `notifications/initialized` ACK, `tools/list`,
// AND (unlike the Task 6/mcp-yaml-vectorization stubs) a REAL `tools/call`
// handler that records every call and can be told, per-call, to answer with
// a tool-level error (`isError: true`) instead of a success.
// ---------------------------------------------------------------------------

interface McpStub {
  url: string;
  calls: Array<{ name: string; args: unknown }>;
  close: () => Promise<void>;
}

async function startMcpStub(
  toolNames: string[],
  resultText: string,
): Promise<McpStub> {
  const calls: Array<{ name: string; args: unknown }> = [];
  const reply = (
    res: http.ServerResponse,
    id: unknown,
    result: unknown,
  ): void => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
  };

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      let msg: {
        method?: string;
        id?: unknown;
        params?: { name?: string; arguments?: unknown };
      };
      try {
        msg = JSON.parse(body);
      } catch {
        res.writeHead(202);
        res.end();
        return;
      }
      if (msg.method === 'initialize') {
        res.setHeader('mcp-session-id', `session-${Math.random()}`);
        reply(res, msg.id, {
          protocolVersion: '2025-11-25',
          capabilities: { tools: {} },
          serverInfo: { name: 'mcp-stub', version: '1.0.0' },
        });
        return;
      }
      if (msg.method?.startsWith('notifications/')) {
        res.writeHead(202);
        res.end();
        return;
      }
      if (msg.method === 'tools/list') {
        reply(res, msg.id, {
          tools: toolNames.map((name) => ({
            name,
            description: `Tool ${name}`,
            inputSchema: { type: 'object', properties: {} },
          })),
        });
        return;
      }
      if (msg.method === 'tools/call') {
        const name = msg.params?.name ?? '';
        const args = msg.params?.arguments;
        calls.push({ name, args });
        const forceError = !!(
          args &&
          typeof args === 'object' &&
          (args as Record<string, unknown>).forceToolError
        );
        reply(
          res,
          msg.id,
          forceError
            ? {
                content: [{ type: 'text', text: `${resultText}-error` }],
                isError: true,
              }
            : { content: [{ type: 'text', text: resultText }] },
        );
        return;
      }
      res.writeHead(202);
      res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp/stream/http`,
    calls,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

/** Reject (not hang/throw-uncaught) if the sandbox forbids binding a local
 *  socket — turn it into a clean `t.skip()` rather than a false failure.
 *  Established convention (mcp-yaml-vectorization.test.ts,
 *  server-namespace-snapshot.test.ts): only the FIRST bind in a test needs
 *  the guard — if the sandbox allows one bind, it allows the rest. */
async function startStubOrSkip(
  t: { skip: (m?: string) => void },
  toolNames: string[],
  resultText: string,
): Promise<McpStub | null> {
  try {
    return await startMcpStub(toolNames, resultText);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'EPERM' || code === 'EACCES') {
      t.skip(`environment forbids server.listen (${code})`);
      return null;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Reach the private routing/infra surfaces without changing visibility —
// the same accepted pattern used by server-routing-namespace.test.ts (Task
// 8) and server-namespace-snapshot.test.ts (Task 6).
// ---------------------------------------------------------------------------

interface Internals {
  buildServerCtx(scope: {
    sessionId: string;
    parts: SessionAgentParts;
  }): Promise<IServerPipelineContext>;
  callMcp(
    name: string,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<{ text: string; isError: boolean }>;
  _buildEmbeddedAgent(): Promise<{
    agent: unknown;
    close: () => Promise<void>;
  }>;
  _toolsRagHandle?: { lookup(name: string): LlmTool | undefined };
  _sharedMcpClients?: IMcpClient[];
}

/** Boot a real SmartServer over TWO real, colliding-`Search` MCP servers
 *  (no `rag:` config — every test in this file therefore ALSO exercises the
 *  "no-writable-RAG deployment" case: the authoritative snapshot + catalog
 *  are built independent of any RAG store). */
async function bootTwoServerSmartServer(t: {
  skip: (m?: string) => void;
}): Promise<{
  server: SmartServer;
  internals: Internals;
  stub0: McpStub;
  stub1: McpStub;
  mcpCfg: SmartServerMcpConfig[];
  close: () => Promise<void>;
} | null> {
  const stub0 = await startStubOrSkip(t, ['Search'], 'db-result');
  if (!stub0) return null;
  const stub1 = await startMcpStub(['Search'], 'weather-result');
  const mcpCfg: SmartServerMcpConfig[] = [
    { type: 'http', url: stub0.url },
    { type: 'http', url: stub1.url },
  ];
  const server = new SmartServer({
    port: 0,
    llm: { apiKey: 'test', model: 'test-model' },
    skipModelValidation: true,
    mcp: mcpCfg,
  });
  const handle = await server.start();
  return {
    server,
    internals: server as unknown as Internals,
    stub0,
    stub1,
    mcpCfg,
    close: async () => {
      await handle.close();
      await stub0.close();
      await stub1.close().catch(() => {}); // may already be closed by a test
    },
  };
}

function freshSessionParts(
  sessionId: string,
  mcpClients: IMcpClient[],
  descriptors: ReturnType<typeof buildSessionMcpClients>['clientDescriptors'],
): SessionAgentParts {
  return {
    sessionId,
    mcpClients,
    mcpClientDescriptors: descriptors,
    toolsRag: undefined,
    ragRegistry: {} as never,
    logger: new SessionRequestLogger(),
  };
}

// ---------------------------------------------------------------------------
// 1. Session-availability (the P1 headline) + fail-loud vs isError vs
//    "Tool not found" — all through a REAL per-session rebind over a
//    genuinely booted authoritative snapshot.
// ---------------------------------------------------------------------------

test('session-availability: a session where server 1 is DOWN still routes s0__Search to the healthy server 0; s1__Search throws fail-loud (not "Tool not found"); a tool-level failure is isError, not a throw', async (t) => {
  const boot = await bootTwoServerSmartServer(t);
  if (!boot) return;
  const { internals, stub0, stub1, mcpCfg, close } = boot;
  try {
    // Boot vectorized BOTH exposed names — proves the P1 collision-not-
    // config-stable fix (the snapshot is built ONCE over the full active
    // set) AND, since no `rag:` was configured anywhere, the no-writable-
    // RAG resilience in the same assertion.
    assert.ok(
      internals._toolsRagHandle?.lookup('s0__Search'),
      'boot must vectorize s0__Search into the catalog',
    );
    assert.ok(
      internals._toolsRagHandle?.lookup('s1__Search'),
      'boot must vectorize s1__Search into the catalog',
    );

    // Simulate server 1 going down IN THIS SESSION: close its real listener.
    // The session's own MCP client is a FRESH, lazily-connecting wrapper
    // (#213 isolation via buildSessionMcpClients) — its first connect
    // attempt now genuinely fails (ECONNREFUSED), independent of the
    // GLOBAL client's already-established boot-time connection.
    await stub1.close();

    const sessionMcp = buildSessionMcpClients(mcpCfg);
    const ctx = await internals.buildServerCtx({
      sessionId: 'sess-down',
      parts: freshSessionParts(
        'sess-down',
        sessionMcp.clients,
        sessionMcp.clientDescriptors,
      ),
    });
    assert.ok(
      ctx.toolClientMap,
      'ctx.toolClientMap must be populated from the authoritative snapshot',
    );
    const bridge = buildNamespacedMcpBridge(
      ctx.toolClientMap,
      ctx.mcpFailureClassifier,
    );

    // s0__Search still routes fine to the healthy server 0, original name
    // "Search" on the wire.
    const ok = await bridge('s0__Search', {});
    assert.equal(ok.isError, false);
    assert.deepEqual(stub0.calls, [{ name: 'Search', args: {} }]);

    // A genuine TOOL-LEVEL failure on the healthy server → isError, never a
    // throw (the shared bridge's classify/throw-vs-isError split, proven
    // here over a REAL network round-trip, not a fake classifier).
    const toolErr = await bridge('s0__Search', { forceToolError: true });
    assert.equal(
      toolErr.isError,
      true,
      'a tool-level error must surface as isError, not a throw',
    );

    // s1__Search: the session's client SLOT exists (dense per-session map —
    // every snapshot exposed name gets an entry regardless of availability),
    // but the server behind it is down → the classifier THROWS (fail-loud
    // availability, #213) — never "Tool not found" (reserved for a
    // genuinely unknown name) and never a silent bare-name collapse.
    await assert.rejects(
      () => bridge('s1__Search', {}),
      (err: unknown) => {
        assert.ok(
          err instanceof McpError && isMcpUnavailable(err),
          `expected a classified-unavailable McpError, got: ${String(err)}`,
        );
        return true;
      },
    );
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// 2. Per-session isolation (#213): two sessions get DISTINCT client
//    instances; a namespaced call in session A reaches ONLY A's instance —
//    never the global clients, never session B's.
// ---------------------------------------------------------------------------

test('per-session isolation: two sessions get distinct MCP client instances; a namespaced call in session A reaches ONLY As instance', async (t) => {
  const boot = await bootTwoServerSmartServer(t);
  if (!boot) return;
  const { internals, stub0, stub1, mcpCfg, close } = boot;
  try {
    const sessA = buildSessionMcpClients(mcpCfg);
    const sessB = buildSessionMcpClients(mcpCfg);
    try {
      assert.notEqual(
        sessA.clients[1],
        sessB.clients[1],
        'two sessions must get DISTINCT client instances for the same slot',
      );
      assert.notEqual(
        sessA.clients[1],
        internals._sharedMcpClients?.[1],
        'a session client must differ from the GLOBAL shared client (#213)',
      );

      const wrapWithSpy = (
        client: IMcpClient,
        calls: string[],
      ): IMcpClient => ({
        ...client,
        callTool: async (name, args, opts) => {
          calls.push(name);
          return client.callTool(name, args, opts);
        },
      });
      const callsA: string[] = [];
      const callsB: string[] = [];

      const ctxA = await internals.buildServerCtx({
        sessionId: 'sess-a',
        parts: freshSessionParts(
          'sess-a',
          [sessA.clients[0], wrapWithSpy(sessA.clients[1], callsA)],
          sessA.clientDescriptors,
        ),
      });
      const ctxB = await internals.buildServerCtx({
        sessionId: 'sess-b',
        parts: freshSessionParts(
          'sess-b',
          [sessB.clients[0], wrapWithSpy(sessB.clients[1], callsB)],
          sessB.clientDescriptors,
        ),
      });
      assert.ok(ctxA.toolClientMap);
      assert.ok(ctxB.toolClientMap);
      const bridgeA = buildNamespacedMcpBridge(
        ctxA.toolClientMap,
        ctxA.mcpFailureClassifier,
      );
      const bridgeB = buildNamespacedMcpBridge(
        ctxB.toolClientMap,
        ctxB.mcpFailureClassifier,
      );

      const result = await bridgeA('s1__Search', {});
      assert.equal(result.isError, false);
      assert.deepEqual(
        callsA,
        ['Search'],
        'session As own client must receive the call, original name on the wire',
      );
      assert.deepEqual(
        callsB,
        [],
        'session B must NEVER be touched by a call routed through session A',
      );

      // Symmetric check: a call routed through B's bridge reaches ONLY B's
      // spy — A's is untouched by it.
      const resultB = await bridgeB('s1__Search', {});
      assert.equal(resultB.isError, false);
      assert.deepEqual(callsB, ['Search']);
      assert.deepEqual(
        callsA,
        ['Search'],
        'session As call count must stay unchanged by a call through B',
      );

      assert.deepEqual(stub1.calls, [
        { name: 'Search', args: {} },
        { name: 'Search', args: {} },
      ]);
      assert.deepEqual(
        stub0.calls,
        [],
        'the unrelated slot-0 server must never be called',
      );
    } finally {
      await sessA.close();
      await sessB.close();
    }
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// 3. `mcp[].name` labels — yaml-builder path (real `server.start()` boot)
//    yields `label__Search` and it is callable.
// ---------------------------------------------------------------------------

test('mcp[].name labels — yaml-builder path (real boot) yields label__Search and is callable', async (t) => {
  const stubPrimary = await startStubOrSkip(t, ['Search'], 'primary-result');
  if (!stubPrimary) return;
  const stubSecondary = await startMcpStub(['Search'], 'secondary-result');
  const server = new SmartServer({
    port: 0,
    llm: { apiKey: 'test', model: 'test-model' },
    skipModelValidation: true,
    mcp: [
      { type: 'http', url: stubPrimary.url, name: 'primary' },
      { type: 'http', url: stubSecondary.url, name: 'secondary' },
    ],
  });
  const handle = await server.start();
  const internals = server as unknown as Internals;
  try {
    assert.ok(internals._toolsRagHandle?.lookup('primary__Search'));
    assert.ok(internals._toolsRagHandle?.lookup('secondary__Search'));

    const result = await internals.callMcp('secondary__Search', {});
    assert.equal(result.isError, false);
    assert.deepEqual(stubSecondary.calls, [{ name: 'Search', args: {} }]);
    assert.deepEqual(
      stubPrimary.calls,
      [],
      'the wrong-labeled server must never be called',
    );
  } finally {
    await handle.close();
    await stubPrimary.close();
    await stubSecondary.close();
  }
});

// ---------------------------------------------------------------------------
// 4. `mcp[].name` labels — the DEFAULT connector
//    (`connectMcpClientsWithDescriptorsFromConfig`) over a REAL live
//    transport. `stepper-mcp-from-config.test.ts` explicitly defers this
//    ("requires a live transport... validated by the maintainer's live
//    re-test") — this closes that gap with real sockets.
// ---------------------------------------------------------------------------

test('mcp[].name labels — the default connector (connectMcpClientsWithDescriptorsFromConfig) over a real transport yields label__Search and is callable', async (t) => {
  const stubPrimary = await startStubOrSkip(t, ['Search'], 'primary-result');
  if (!stubPrimary) return;
  const stubSecondary = await startMcpStub(['Search'], 'secondary-result');
  try {
    const resolved = await connectMcpClientsWithDescriptorsFromConfig([
      { type: 'http', url: stubPrimary.url, name: 'primary' },
      { type: 'http', url: stubSecondary.url, name: 'secondary' },
    ]);
    assert.deepEqual(resolved.clientDescriptors, [
      { slotIndex: 0, label: 'primary' },
      { slotIndex: 1, label: 'secondary' },
    ]);
    assert.equal(resolved.configuredSlotCount, 2);

    // Compose with the SAME production buildNamespacedTools the server uses
    // — real listTools() over the real clients this connector produced.
    const descriptors = resolved.clientDescriptors ?? [];
    const perClient = await Promise.all(
      resolved.clients.map(async (client, i) => {
        const listed = await client.listTools();
        return {
          slotIndex: descriptors[i]?.slotIndex ?? i,
          label: descriptors[i]?.label,
          client,
          tools: listed.ok ? (listed.value as McpTool[]) : [],
        };
      }),
    );
    const { tools, toolClientMap } = buildNamespacedTools(
      perClient,
      defaultToolNamespace,
    );
    assert.deepEqual(tools.map((tt) => tt.name).sort(), [
      'primary__Search',
      'secondary__Search',
    ]);

    const secondaryClient = toolClientMap.get('secondary__Search');
    assert.ok(secondaryClient);
    const result = await secondaryClient.callTool('secondary__Search', {});
    assert.equal(result.ok, true);
    assert.deepEqual(stubSecondary.calls, [{ name: 'Search', args: {} }]);
    assert.deepEqual(stubPrimary.calls, []);
  } finally {
    await stubPrimary.close();
    await stubSecondary.close();
  }
});

// ---------------------------------------------------------------------------
// 5. A bare custom `connectMcp` seam (no descriptors) falls back to
//    `s0__Search` (array-index, no label) and stays callable.
// ---------------------------------------------------------------------------

test('bare custom connectMcp seam (no descriptors) falls back to s0__Search and stays callable', async () => {
  const calls: Array<{ client: string; name: string }> = [];
  const fakeClient = (id: string): IMcpClient =>
    ({
      async listTools() {
        return {
          ok: true as const,
          value: [{ name: 'Search', description: 'search', inputSchema: {} }],
        };
      },
      async callTool(name: string) {
        calls.push({ client: id, name });
        return { ok: true as const, value: { content: `ok-${id}` } };
      },
    }) as IMcpClient;

  const server = new SmartServer(
    {
      llm: { apiKey: 'test', model: 'test-model' },
      skipModelValidation: true,
      mcp: { type: 'http', url: 'http://127.0.0.1:9/unused' },
    },
    {
      connectMcp: async () => [fakeClient('c0'), fakeClient('c1')],
    },
  );
  const internals = server as unknown as Internals;
  const built = await internals._buildEmbeddedAgent();
  try {
    assert.ok(
      internals._toolsRagHandle?.lookup('s0__Search'),
      'a bare connectMcp (no labels) must still fall back to s0__Search',
    );
    const result = await internals.callMcp('s0__Search', {});
    assert.equal(result.isError, false);
    assert.deepEqual(calls, [{ client: 'c0', name: 'Search' }]);
  } finally {
    await built.close();
  }
});

// ---------------------------------------------------------------------------
// 6. Controller pipeline (session `ctx.toolClientMap`) over REAL booted
//    state — s1__Search routes to the SESSION's client-1 instance through
//    the production ControllerPipelinePlugin, never the global clients.
// ---------------------------------------------------------------------------

const SEARCH_TOOL = (name: string): LlmTool =>
  ({
    name,
    description: 'search',
    inputSchema: { type: 'object' },
  }) as unknown as LlmTool;

function scriptedRoleLlm(model: string, queue: Partial<LlmResponse>[]): ILlm {
  return {
    model,
    chat: async () => {
      const next = queue.shift() ?? { content: '' };
      return {
        ok: true as const,
        value: { content: '', toolCalls: [], ...next } as LlmResponse,
      };
    },
    streamChat: async function* () {},
  } as unknown as ILlm;
}

const constEmbedder = {
  embed: async () => ({ vector: [1, 0, 0] }),
  dimensions: 3,
} as unknown as import('@mcp-abap-adt/llm-agent').IEmbedder;

test('controller pipeline: over a REAL boot, s1__Search routes to the SESSION client-1 instance, never the global clients', async (t) => {
  const boot = await bootTwoServerSmartServer(t);
  if (!boot) return;
  const { internals, stub0, stub1, mcpCfg, close } = boot;
  try {
    const sessionMcp = buildSessionMcpClients(mcpCfg);
    const ctx = await internals.buildServerCtx({
      sessionId: 'sess-controller',
      parts: freshSessionParts(
        'sess-controller',
        sessionMcp.clients,
        sessionMcp.clientDescriptors,
      ),
    });
    assert.ok(ctx.toolClientMap);

    const byModel: Record<string, ILlm> = {
      'm-eval': scriptedRoleLlm('m-eval', [{ content: 'Goal: search stuff' }]),
      'm-plan': scriptedRoleLlm('m-plan', [
        {
          content: JSON.stringify({
            plan: [{ name: 's1', instructions: 'search' }],
          }),
        },
        { content: 'done' },
      ]),
      'm-exec': scriptedRoleLlm('m-exec', [
        {
          toolCalls: [{ id: 'c1', name: 's1__Search', arguments: { q: 'x' } }],
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

    const base = fakeControllerServerCtx();
    const fullCtx = {
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
      // A DIFFERENT (wrong) global set — only reached by the FALLBACK
      // bridge, never by a correctly-namespaced dispatch.
      mcpClients: internals._sharedMcpClients,
      toolClientMap: ctx.toolClientMap,
      makeLlm: async (c: { model?: string }) =>
        byModel[c.model ?? ''] ?? byModel['m-exec'],
    } as unknown as Parameters<typeof plugin.build>[1];

    const inst = await plugin.build(cfg, fullCtx);
    try {
      for await (const chunk of inst.agent.streamProcess('search stuff')) {
        void chunk;
      }
    } finally {
      await inst.close();
    }

    assert.deepEqual(
      stub1.calls,
      [{ name: 'Search', args: { q: 'x' } }],
      'the SESSION client-1 must receive exactly one call, original name Search',
    );
    assert.deepEqual(
      stub0.calls,
      [],
      'server 0 must NEVER be called for a s1__Search dispatch',
    );
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// 7. Stepper pipeline (global `callMcp` map) over REAL booted state —
//    s1__Search routes to server 1 with the original name, through the
//    REAL production Stepper/CyclicReActExecutor/RootFinalizer runtime
//    (the same production machinery StepperPipelinePlugin composes).
// ---------------------------------------------------------------------------

test('stepper pipeline: over a REAL boot, s1__Search routes to server 1 with the original name through the real CyclicReActExecutor, server 0 never called', async (t) => {
  const boot = await bootTwoServerSmartServer(t);
  if (!boot) return;
  const { internals, stub0, stub1, close } = boot;
  try {
    const knowledgeRag = new KnowledgeRag(
      new InMemoryKnowledgeBackend(),
      'sess-stepper',
    );

    // Mirrors stepper-callmcp-bridge.test.ts's proven script shape: turn 1
    // emits the tool call, EVERY subsequent call (executor turn 2, and any
    // finalizer role call) returns a plain final answer — robust to however
    // many follow-up LLM calls the real coordinator makes.
    let llmCalls = 0;
    const scriptedLlm = {
      name: 'stub',
      model: 'stub',
      async chat() {
        llmCalls++;
        if (llmCalls === 1) {
          return {
            ok: true as const,
            value: {
              content: 'searching',
              toolCalls: [{ name: 's1__Search', arguments: { q: 'weather' } }],
              usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            },
          };
        }
        return {
          ok: true as const,
          value: {
            content: 'The weather search is complete.',
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          },
        };
      },
      async *streamChat() {
        yield {
          ok: true as const,
          value: { content: 'done', finishReason: 'stop' },
        };
      },
    } as unknown as ILlm;

    // The REAL, genuinely-booted namespaced callMcp bridge (global
    // _sharedMcpClients + the authoritative snapshot), adapted to the
    // Promise<string> contract the Stepper root expects — the exact
    // adaptation `CyclicFactory`'s own `buildStepperCoordinator` performs
    // (`deps.callMcp(n, a, s).then((r) => r.text)`).
    const callMcp = (name: string, args: unknown, signal?: AbortSignal) =>
      internals.callMcp(name, args, signal).then((r) => r.text);

    const built = await buildStepperRoot({
      coordCfg: {
        mode: 'cyclic-react',
        flow: { evaluator: { enabled: false } },
        stepper: { reviewer: { atDepths: [] } },
      },
      registry: new Map(),
      makeLlm: async () => scriptedLlm,
      knowledgeRagFor: () => knowledgeRag as never,
      toolsRag: internals._toolsRagHandle as never,
      callMcp,
      mintStepperId: (() => {
        let i = 0;
        return () => `s${i++}`;
      })(),
    });

    const result = await built.rootStepper.run({
      prompt: 'search the weather',
      knowledgeRag: knowledgeRag as never,
      toolsRag: internals._toolsRagHandle as never,
      budget: { depthRemaining: 0, tokens: new TokenLedger(100_000) },
      identity: {
        traceId: 'trace-stepper',
        turnId: 'turn-stepper',
        sessionId: 'sess-stepper',
        stepperId: 's0',
      },
    });

    assert.equal(
      result.status,
      'ok',
      `expected the stepper run to complete ok, got: ${result.status}`,
    );
    assert.deepEqual(
      stub1.calls,
      [{ name: 'Search', args: { q: 'weather' } }],
      'server 1 must receive exactly one call, original name Search',
    );
    assert.deepEqual(
      stub0.calls,
      [],
      'server 0 must NEVER be called for a s1__Search dispatch',
    );
  } finally {
    await close();
  }
});
