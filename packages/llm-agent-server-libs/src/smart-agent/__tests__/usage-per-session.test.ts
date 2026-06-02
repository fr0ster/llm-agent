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

test('per-session usage is independent and resets on evict', async () => {
  const lc = buildSessionLifecycle({
    idleTtlMs: 0,
    maxSessions: 100,
    cookieName: 'sid',
    mcpClients: [],
    toolsRag: undefined,
    ragRegistry: makeRagRegistry(),
    buildAgent: async () => undefined,
  });

  const g1 = await lc.acquire('s1');
  const g2 = await lc.acquire('s2');

  g1.logger.startRequest('r1');
  g1.logger.logLlmCall({
    component: 'tool-loop' as never,
    model: 'm',
    promptTokens: 10,
    completionTokens: 0,
    totalTokens: 10,
    durationMs: 1,
    requestId: 'r1',
  });
  g1.logger.endRequest('r1');

  g2.logger.startRequest('r2');
  g2.logger.logLlmCall({
    component: 'tool-loop' as never,
    model: 'm',
    promptTokens: 3,
    completionTokens: 0,
    totalTokens: 3,
    durationMs: 1,
    requestId: 'r2',
  });
  g2.logger.endRequest('r2');

  assert.equal(g1.logger.getSummary().byComponent['tool-loop'].totalTokens, 10);
  assert.equal(g2.logger.getSummary().byComponent['tool-loop'].totalTokens, 3);

  // Release s1 (unpins it); s2 stays pinned (active=1). idleTtlMs:0 -> evict.
  lc.release('s1');
  await lc.evictIdle();

  // g1 was disposed -> logger.reset() cleared its tally;
  // g2 untouched (still pinned), its summary survives.
  assert.equal(
    g1.logger.getSummary().byComponent['tool-loop']?.totalTokens ?? 0,
    0,
    'evicted session logger is reset',
  );
  assert.equal(g2.logger.getSummary().byComponent['tool-loop'].totalTokens, 3);

  // Cleanup
  lc.release('s2');
  await lc.disposeAll();
});
