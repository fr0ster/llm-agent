import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IRagRegistry } from '@mcp-abap-adt/llm-agent';
import {
  SessionGraphFactory,
  type SessionGraphIdentity,
} from '../session-graph-factory.js';

function stubRegistry() {
  const closed: string[] = [];
  const registry = {
    closeSession: async (id: string) => {
      closed.push(id);
      return { ok: true as const, value: undefined };
    },
  } as unknown as IRagRegistry;
  return { registry, closed };
}

test('without a factory, the shared registry is handed over and closed — exactly as before', async () => {
  const shared = stubRegistry();
  const handed: unknown[] = [];
  const factory = new SessionGraphFactory({
    mcpClientFactory: () => [],
    toolsRag: undefined,
    ragRegistry: shared.registry,
    buildAgent: async (parts) => {
      handed.push(parts.ragRegistry);
      return undefined;
    },
  });
  const graph = await factory.build({ sessionId: 's-1', userId: 'u-1' });
  assert.equal(handed[0], shared.registry);
  await graph.dispose();
  assert.deepEqual(shared.closed, ['s-1']);
});

test('with a factory, it receives the FULL identity, and its registry is the session’s', async () => {
  const shared = stubRegistry();
  const owned = stubRegistry();
  const seen: SessionGraphIdentity[] = [];
  const handed: unknown[] = [];
  const factory = new SessionGraphFactory({
    mcpClientFactory: () => [],
    toolsRag: undefined,
    ragRegistry: shared.registry,
    ragRegistryFactory: async (identity) => {
      seen.push(identity);
      return owned.registry;
    },
    buildAgent: async (parts) => {
      handed.push(parts.ragRegistry);
      return undefined;
    },
  });
  const graph = await factory.build({ sessionId: 's-2', userId: 'u-2' });
  assert.deepEqual(
    seen,
    [{ sessionId: 's-2', userId: 'u-2' }],
    'both keys, not just the session',
  );
  assert.equal(handed[0], owned.registry);
  await graph.dispose();
  assert.deepEqual(
    owned.closed,
    ['s-2'],
    'dispose closed the session’s own registry',
  );
  assert.deepEqual(shared.closed, [], 'and never touched the shared one');
});

test('each session gets the registry its own call returned', async () => {
  const handed: unknown[] = [];
  let calls = 0;
  const factory = new SessionGraphFactory({
    mcpClientFactory: () => [],
    toolsRag: undefined,
    ragRegistryFactory: async () => {
      calls += 1;
      return stubRegistry().registry;
    },
    buildAgent: async (parts) => {
      handed.push(parts.ragRegistry);
      return undefined;
    },
  });
  await factory.build({ sessionId: 'a' });
  await factory.build({ sessionId: 'b' });
  assert.equal(calls, 2);
  assert.notEqual(handed[0], handed[1]);
});

test('the factory is awaited, so it can hydrate', async () => {
  const owned = stubRegistry();
  let hydrated = false;
  const handed: unknown[] = [];
  const factory = new SessionGraphFactory({
    mcpClientFactory: () => [],
    toolsRag: undefined,
    ragRegistryFactory: async () => {
      await new Promise((r) => setTimeout(r, 1));
      hydrated = true;
      return owned.registry;
    },
    buildAgent: async (parts) => {
      handed.push(parts.ragRegistry);
      return undefined;
    },
  });
  await factory.build({ sessionId: 's-3' });
  assert.equal(hydrated, true);
  assert.equal(handed[0], owned.registry);
});

test('a factory that rejects fails the build before any MCP client is resolved', async () => {
  let mcpCalls = 0;
  const factory = new SessionGraphFactory({
    mcpClientFactory: () => {
      mcpCalls += 1;
      return [];
    },
    toolsRag: undefined,
    ragRegistryFactory: async () => {
      throw new Error('catalog unreachable');
    },
    buildAgent: async () => undefined,
  });
  await assert.rejects(
    () => factory.build({ sessionId: 's-4' }),
    /catalog unreachable/,
  );
  assert.equal(mcpCalls, 0, 'nothing started that would need stopping');
});

test('neither a registry nor a factory is refused at build', async () => {
  const factory = new SessionGraphFactory({
    mcpClientFactory: () => [],
    toolsRag: undefined,
    buildAgent: async () => undefined,
  });
  await assert.rejects(
    () => factory.build({ sessionId: 's-5' }),
    /needs one of ragRegistryFactory or ragRegistry/,
  );
});
