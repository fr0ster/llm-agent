import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import {
  InMemoryRagProvider,
  SimpleRagProviderRegistry,
  SimpleRagRegistry,
} from '@mcp-abap-adt/llm-agent';
import { buildSessionLifecycle } from '../smart-server.js';

function makeRagRegistry() {
  const providers = new SimpleRagProviderRegistry();
  providers.registerProvider(new InMemoryRagProvider({ name: 'mem' }));
  const reg = new SimpleRagRegistry();
  reg.setProviderRegistry(providers);
  return reg;
}

test('first request mints a cookie; dispose closes session collections on the shared registry', async () => {
  const ragRegistry = makeRagRegistry();
  const lc = buildSessionLifecycle({
    idleTtlMs: 0,
    maxSessions: 100,
    cookieName: 'sid',
    mcpClients: [],
    toolsRag: undefined,
    ragRegistry,
    buildAgent: async () => undefined,
  });

  const r = lc.resolve(undefined, false); // no cookie, not HTTPS
  assert.equal(r.minted, true);
  assert.match(r.setCookie ?? '', /^sid=/);

  const sid = r.identity.sessionId;
  const created = await ragRegistry.createCollection({
    providerName: 'mem',
    collectionName: 'c',
    scope: 'session',
    sessionId: sid,
  });
  assert.equal(created.ok, true);
  assert.ok(ragRegistry.get('c'));

  const g = await lc.acquire(sid);
  assert.equal(g.isPinned, true);
  lc.release(sid);
  await lc.evictIdle();

  assert.equal(
    ragRegistry.get('c'),
    undefined,
    'session collection cleared on evict',
  );
});

test('graceful shutdown: server.close() resolves BEFORE lifecycle.disposeAll() runs (active-request pinning safe)', async () => {
  // Reproduces the close() pattern in SmartServer.start():
  //   1. await server.close()  — drains in-flight HTTP
  //   2. for closeFns: await fn()  — disposes lifecycle/session graphs
  // If the order ever regresses, the sequence array below will reorder and
  // the assertion will fail.
  const sequence: string[] = [];
  const ragRegistry = makeRagRegistry();
  const lifecycle = buildSessionLifecycle({
    idleTtlMs: 10_000,
    maxSessions: 10,
    cookieName: 'sid',
    mcpClients: [],
    toolsRag: undefined,
    ragRegistry,
    buildAgent: async () => undefined,
  });

  const closeFns: Array<() => Promise<void> | void> = [
    async () => {
      sequence.push('lifecycle-disposed');
      await lifecycle.disposeAll();
    },
  ];

  // Stand up a real http.Server bound to a non-listening port; we never need
  // an inbound connection — we just need server.close() to be a real awaited
  // event that completes asynchronously, so we can verify the ordering pattern.
  const server = http.createServer(() => {});
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', () => res()));

  // Apply the SAME close() pattern as SmartServer.start().
  await (async () => {
    await new Promise<void>((res, rej) =>
      server.close((e) => (e ? rej(e) : res())),
    );
    sequence.push('server-closed');
    for (const fn of closeFns) await fn();
  })();

  assert.deepEqual(
    sequence,
    ['server-closed', 'lifecycle-disposed'],
    'server.close() must resolve BEFORE lifecycle.disposeAll() runs',
  );
});

test('two no-cookie requests get distinct session ids (no shared default bucket)', () => {
  const lc = buildSessionLifecycle({
    idleTtlMs: 10_000,
    maxSessions: 100,
    cookieName: 'sid',
    mcpClients: [],
    toolsRag: undefined,
    ragRegistry: makeRagRegistry(),
    buildAgent: async () => undefined,
  });
  assert.notEqual(
    lc.resolve(undefined, false).identity.sessionId,
    lc.resolve(undefined, false).identity.sessionId,
  );
});

test('dropRequest frees the delta but session-cumulative survives (server-owned free)', async () => {
  const lc = buildSessionLifecycle({
    idleTtlMs: 10_000,
    maxSessions: 100,
    cookieName: 'sid',
    mcpClients: [],
    toolsRag: undefined,
    ragRegistry: makeRagRegistry(),
    buildAgent: async () => undefined,
  });
  const g = await lc.acquire('s1');
  g.logger.startRequest('t');
  g.logger.logLlmCall({
    component: 'tool-loop' as never,
    model: 'm',
    promptTokens: 9,
    completionTokens: 0,
    totalTokens: 9,
    durationMs: 1,
    requestId: 't',
  });
  g.logger.endRequest('t'); // worker/agent end — delta survives
  assert.equal(
    g.logger.getSummary('t').byComponent['tool-loop'].totalTokens,
    9,
  );
  g.logger.dropRequest('t'); // server frees AFTER reading usage
  assert.equal(Object.keys(g.logger.getSummary('t').byComponent).length, 0);
  assert.equal(
    g.logger.getSummary().byComponent['tool-loop'].totalTokens,
    9,
    'cumulative survives',
  );
  lc.release('s1');
});
