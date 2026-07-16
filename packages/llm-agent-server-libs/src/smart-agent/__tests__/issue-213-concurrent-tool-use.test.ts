/**
 * Regression test for #213 — per-session MCP client isolation.
 *
 * Verifies that concurrent tool-use across distinct sessions uses DISTINCT MCP
 * clients so responses never cross between sessions. Drives the fix at the
 * `buildSessionLifecycle` factory level (Tasks 1-4) using fake `IMcpClient`s —
 * no real network connections opened.
 *
 * Discrimination proof (third test): forcing the SHARED wiring
 * (`mcpSharedClient: true`) causes the "distinct instances" assertion to FAIL,
 * confirming the first two tests actually guard the per-session guarantee.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IMcpClient, McpToolResult } from '@mcp-abap-adt/llm-agent';
import {
  InMemoryRagProvider,
  SimpleRagProviderRegistry,
  SimpleRagRegistry,
} from '@mcp-abap-adt/llm-agent';
import type { SessionAgentParts } from '@mcp-abap-adt/llm-agent-libs';
import { buildSessionLifecycle } from '../session-lifecycle/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRagRegistry() {
  const providers = new SimpleRagProviderRegistry();
  providers.registerProvider(new InMemoryRagProvider({ name: 'mem' }));
  const reg = new SimpleRagRegistry();
  reg.setProviderRegistry(providers);
  return reg;
}

/**
 * Fake MCP client whose `callTool` always resolves with the supplied token.
 * The token encodes which session/instance produced the client, so crossing
 * (session A getting session B's token) is immediately detectable.
 */
function makeFakeClient(token: string): IMcpClient {
  return {
    async listTools() {
      return { ok: true as const, value: [] };
    },
    async callTool(_name: string, _args: Record<string, unknown>) {
      return {
        ok: true as const,
        value: { content: token } satisfies McpToolResult,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('#213 per-session (default): concurrent acquire returns DISTINCT client instances; callTool returns session-specific tokens — no crossing', async () => {
  const ragRegistry = makeRagRegistry();
  let instanceCounter = 0;
  const capturedClients: IMcpClient[][] = [];

  const lc = buildSessionLifecycle({
    idleTtlMs: 10_000,
    maxSessions: 10,
    cookieName: 'sid',
    mcpClients: [makeFakeClient('shared-fallback')],
    toolsRag: undefined,
    ragRegistry,
    buildPerSessionMcpClients: () => {
      const token = `token-${++instanceCounter}`;
      return { clients: [makeFakeClient(token)], close: async () => {} };
    },
    buildAgent: async (parts: SessionAgentParts) => {
      capturedClients.push(parts.mcpClients as IMcpClient[]);
      return undefined;
    },
  });

  // Acquire two sessions concurrently — the critical concurrent path
  await Promise.all([lc.acquire('session-A'), lc.acquire('session-B')]);

  assert.equal(capturedClients.length, 2, 'both sessions acquired');

  // Each session must hold a DISTINCT client array and a DISTINCT client object
  assert.notEqual(
    capturedClients[0],
    capturedClients[1],
    'DISTINCT client arrays per session',
  );
  assert.notEqual(
    capturedClients[0][0],
    capturedClients[1][0],
    'DISTINCT client instances per session',
  );

  // Concurrent callTool calls must return session-specific tokens → no crossing
  const [resultA, resultB] = await Promise.all([
    capturedClients[0][0].callTool('any', {}),
    capturedClients[1][0].callTool('any', {}),
  ]);
  assert.ok(resultA.ok, 'session A callTool succeeded');
  assert.ok(resultB.ok, 'session B callTool succeeded');
  const tokenA = (resultA.value as McpToolResult).content as string;
  const tokenB = (resultB.value as McpToolResult).content as string;
  assert.notEqual(
    tokenA,
    tokenB,
    'concurrent callTool results are DISTINCT — no response crossing',
  );
  assert.match(tokenA, /^token-\d+$/, 'session A received a per-session token');
  assert.match(tokenB, /^token-\d+$/, 'session B received a per-session token');

  lc.release('session-A');
  lc.release('session-B');
  await lc.disposeAll();
});

test('#213 shared opt-out: mcpSharedClient=true → buildPerSessionMcpClients never called; both sessions share the SAME client instance', async () => {
  const ragRegistry = makeRagRegistry();
  const sharedClient = makeFakeClient('shared-token');
  const sharedClients = [sharedClient];
  let buildCalled = 0;
  const capturedClients: IMcpClient[][] = [];

  const lc = buildSessionLifecycle({
    idleTtlMs: 10_000,
    maxSessions: 10,
    cookieName: 'sid',
    mcpClients: sharedClients,
    toolsRag: undefined,
    ragRegistry,
    mcpSharedClient: true,
    buildPerSessionMcpClients: () => {
      buildCalled++;
      return {
        clients: [makeFakeClient('per-session-token')],
        close: async () => {},
      };
    },
    buildAgent: async (parts: SessionAgentParts) => {
      capturedClients.push(parts.mcpClients as IMcpClient[]);
      return undefined;
    },
  });

  await Promise.all([lc.acquire('session-A'), lc.acquire('session-B')]);

  assert.equal(
    buildCalled,
    0,
    'buildPerSessionMcpClients must NOT be called when mcpSharedClient=true',
  );
  assert.equal(capturedClients.length, 2, 'both sessions acquired');
  assert.equal(
    capturedClients[0],
    sharedClients,
    'session A received the shared mcpClients array reference',
  );
  assert.equal(
    capturedClients[1],
    sharedClients,
    'session B received the shared mcpClients array reference',
  );
  assert.equal(
    capturedClients[0][0],
    capturedClients[1][0],
    'both sessions share the SAME client instance (opt-out documented)',
  );

  lc.release('session-A');
  lc.release('session-B');
  await lc.disposeAll();
});

test('#213 discrimination proof: shared wiring causes per-session "distinct" assertion to FAIL — confirms the first test guards the real isolation', async () => {
  // Force the SHARED path (mcpSharedClient: true) — the pre-fix wiring.
  // The assertions from the first test must FAIL here, proving the test
  // genuinely discriminates between isolated and shared wiring.
  const ragRegistry = makeRagRegistry();
  const sharedClient = makeFakeClient('always-same-token');
  const sharedClients = [sharedClient];
  const capturedClients: IMcpClient[][] = [];

  const lc = buildSessionLifecycle({
    idleTtlMs: 10_000,
    maxSessions: 10,
    cookieName: 'sid',
    mcpClients: sharedClients, // ← shared reference (pre-fix behavior)
    toolsRag: undefined,
    ragRegistry,
    mcpSharedClient: true, // ← forces shared wiring
    buildPerSessionMcpClients: () => ({
      clients: [makeFakeClient('would-be-isolated')],
      close: async () => {},
    }),
    buildAgent: async (parts: SessionAgentParts) => {
      capturedClients.push(parts.mcpClients as IMcpClient[]);
      return undefined;
    },
  });

  await Promise.all([lc.acquire('session-A'), lc.acquire('session-B')]);
  assert.equal(capturedClients.length, 2);

  // --- "distinct instances" assertion FAILS on shared wiring ---
  let distinctInstanceAssertionFailed = false;
  try {
    assert.notEqual(
      capturedClients[0][0],
      capturedClients[1][0],
      'DISTINCT client instances per session',
    );
  } catch {
    distinctInstanceAssertionFailed = true;
  }
  assert.ok(
    distinctInstanceAssertionFailed,
    'DISCRIMINATION PROOF: notEqual(client[0][0], client[1][0]) FAILS on shared wiring — the isolation test would catch a regression',
  );

  // --- callTool crossing IS observable on shared wiring ---
  const [resultA, resultB] = await Promise.all([
    capturedClients[0][0].callTool('any', {}),
    capturedClients[1][0].callTool('any', {}),
  ]);
  const tokenA = (resultA.value as McpToolResult).content as string;
  const tokenB = (resultB.value as McpToolResult).content as string;
  assert.equal(
    tokenA,
    tokenB,
    'DISCRIMINATION PROOF: callTool tokens ARE equal on shared wiring — crossing would occur in production',
  );

  lc.release('session-A');
  lc.release('session-B');
  await lc.disposeAll();
});
