import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  InMemoryRagProvider,
  SimpleRagProviderRegistry,
  SimpleRagRegistry,
} from '@mcp-abap-adt/llm-agent';
import type { SessionAgentParts } from '@mcp-abap-adt/llm-agent-libs';
import { buildSessionLifecycle } from '../index.js';

function makeRagRegistry() {
  const providers = new SimpleRagProviderRegistry();
  providers.registerProvider(new InMemoryRagProvider({ name: 'mem' }));
  const reg = new SimpleRagRegistry();
  reg.setProviderRegistry(providers);
  return reg;
}

// Minimal fake MCP client stub
const fakeClient = () =>
  ({
    async listTools() {
      return { ok: true as const, value: [] };
    },
    async callTool() {
      return { ok: true as const, value: { content: '' } };
    },
  }) as never;

const baseOpts = {
  idleTtlMs: 10_000,
  maxSessions: 10,
  cookieName: 'sid',
  mcpClients: [fakeClient()],
  toolsRag: undefined,
} as const;

test('default: buildPerSessionMcpClients called once per session; each session gets DISTINCT client instances', async () => {
  const ragRegistry = makeRagRegistry();
  let callCount = 0;
  const capturedClients: never[][] = [];

  const lc = buildSessionLifecycle({
    ...baseOpts,
    ragRegistry,
    buildPerSessionMcpClients: () => {
      callCount++;
      const clients = [fakeClient()] as never[];
      return { clients, close: async () => {} };
    },
    buildAgent: async (parts: SessionAgentParts) => {
      capturedClients.push(parts.mcpClients as never[]);
      return undefined;
    },
  });

  await lc.acquire('s1');
  await lc.acquire('s2');

  assert.equal(
    callCount,
    2,
    'buildPerSessionMcpClients called once per session',
  );
  assert.equal(
    capturedClients.length,
    2,
    'buildAgent received clients for both sessions',
  );
  assert.notEqual(
    capturedClients[0],
    capturedClients[1],
    'each session receives a DISTINCT client array instance',
  );
  assert.notEqual(
    capturedClients[0][0],
    capturedClients[1][0],
    'each session receives a DISTINCT client instance',
  );

  lc.release('s1');
  lc.release('s2');
  await lc.disposeAll();
});

test('mcpSharedClient: true → buildPerSessionMcpClients never called; both sessions share opts.mcpClients', async () => {
  const ragRegistry = makeRagRegistry();
  let callCount = 0;
  const capturedClients: never[][] = [];
  const sharedClients = [fakeClient()];

  const lc = buildSessionLifecycle({
    ...baseOpts,
    mcpClients: sharedClients as never[],
    ragRegistry,
    mcpSharedClient: true,
    buildPerSessionMcpClients: () => {
      callCount++;
      return { clients: [fakeClient()] as never[], close: async () => {} };
    },
    buildAgent: async (parts: SessionAgentParts) => {
      capturedClients.push(parts.mcpClients as never[]);
      return undefined;
    },
  });

  await lc.acquire('s1');
  await lc.acquire('s2');

  assert.equal(
    callCount,
    0,
    'buildPerSessionMcpClients must NOT be called when mcpSharedClient=true',
  );
  assert.equal(capturedClients.length, 2);
  assert.equal(
    capturedClients[0],
    sharedClients,
    's1 receives the shared mcpClients',
  );
  assert.equal(
    capturedClients[1],
    sharedClients,
    's2 receives the shared mcpClients',
  );

  lc.release('s1');
  lc.release('s2');
  await lc.disposeAll();
});

test('onDispose: per-session close() runs before opts.onDispose (in order, for the disposed sessionId)', async () => {
  const ragRegistry = makeRagRegistry();
  const order: string[] = [];
  const closedSessions: string[] = [];

  const lc = buildSessionLifecycle({
    ...baseOpts,
    ragRegistry,
    buildPerSessionMcpClients: () => ({
      clients: [fakeClient()] as never[],
      close: async () => {
        order.push('per-session-close');
      },
    }),
    onDispose: async (sessionId: string) => {
      closedSessions.push(sessionId);
      order.push('opts-onDispose');
    },
    buildAgent: async () => undefined,
  });

  const g = await lc.acquire('s1');
  lc.release('s1');

  // Force idle eviction (idleTtlMs=10_000 won't expire, so disposeAll)
  await lc.disposeAll();

  assert.deepEqual(
    order,
    ['per-session-close', 'opts-onDispose'],
    'per-session close runs BEFORE opts.onDispose',
  );
  assert.deepEqual(
    closedSessions,
    ['s1'],
    'opts.onDispose received the correct sessionId',
  );
  void g; // suppress unused warning
});

test('onDispose: only the closed session close() is called; other sessions not affected', async () => {
  const ragRegistry = makeRagRegistry();
  const closedOrder: string[] = [];

  const lc = buildSessionLifecycle({
    ...baseOpts,
    idleTtlMs: 0,
    ragRegistry,
    buildPerSessionMcpClients: () => ({
      clients: [fakeClient()] as never[],
      close: async () => {
        closedOrder.push('close-called');
      },
    }),
    onDispose: async (_sessionId: string) => {},
    buildAgent: async () => undefined,
  });

  await lc.acquire('s1');
  const g2 = await lc.acquire('s2');
  lc.release('s1');

  // evictIdle evicts s1 (released + idleTtlMs=0)
  await lc.evictIdle();

  assert.deepEqual(
    closedOrder,
    ['close-called'],
    'exactly one close() for the evicted session',
  );

  // cleanup
  lc.release('s2');
  await lc.disposeAll();
  void g2;
});
