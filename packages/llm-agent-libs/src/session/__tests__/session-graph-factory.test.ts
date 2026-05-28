import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  InMemoryRagProvider,
  SimpleRagProviderRegistry,
  SimpleRagRegistry,
} from '@mcp-abap-adt/llm-agent';
import { SessionGraphFactory } from '../session-graph-factory.js';

function makeRagRegistry() {
  const providers = new SimpleRagProviderRegistry();
  providers.registerProvider(new InMemoryRagProvider({ name: 'mem' }));
  const reg = new SimpleRagRegistry();
  reg.setProviderRegistry(providers);
  return reg;
}

test('build(identity) yields a graph whose registries+logger differ per session and shares the injected RAG registry; buildAgent receives a FRESH logger per session', async () => {
  const ragRegistry = makeRagRegistry();
  const seenLoggers: unknown[] = [];
  let mcpFactoryCalls = 0;
  const factory = new SessionGraphFactory({
    mcpClientFactory: (_identity) => {
      mcpFactoryCalls++;
      return [];
    },
    toolsRag: undefined,
    ragRegistry,
    buildAgent: async (parts) => {
      assert.equal(parts.ragRegistry, ragRegistry);
      assert.ok(parts.logger);
      seenLoggers.push(parts.logger);
      return undefined;
    },
  });

  const g1 = await factory.build({ sessionId: 's1' });
  const g2 = await factory.build({ sessionId: 's2' });
  assert.notEqual(g1, g2);
  assert.notEqual(g1.toolAvailability, g2.toolAvailability);
  assert.notEqual(g1.pendingToolResults, g2.pendingToolResults);
  assert.notEqual(g1.logger, g2.logger);
  assert.equal(g1.sessionId, 's1');
  assert.equal(seenLoggers[0], g1.logger);
  assert.equal(seenLoggers[1], g2.logger);
  assert.equal(mcpFactoryCalls, 2);
});

test('dispose() of a graph closes session collections on the shared registry only', async () => {
  const ragRegistry = makeRagRegistry();
  const factory = new SessionGraphFactory({
    mcpClientFactory: () => [],
    toolsRag: undefined,
    ragRegistry,
    buildAgent: async () => undefined,
  });
  await ragRegistry.createCollection({
    providerName: 'mem',
    collectionName: 'g-s1',
    scope: 'session',
    sessionId: 's1',
  });
  assert.ok(ragRegistry.get('g-s1'));
  const g = await factory.build({ sessionId: 's1' });
  await g.dispose();
  assert.equal(
    ragRegistry.get('g-s1'),
    undefined,
    'session collection removed on dispose',
  );
});
