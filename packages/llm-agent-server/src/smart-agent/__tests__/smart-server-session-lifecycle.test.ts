import assert from 'node:assert/strict';
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
