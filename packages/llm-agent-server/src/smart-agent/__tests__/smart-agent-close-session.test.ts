import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  InMemoryRag,
  InMemoryRagProvider,
  SimpleRagProviderRegistry,
  SimpleRagRegistry,
} from '@mcp-abap-adt/llm-agent';
import { SmartAgent } from '../agent.js';
import { makeDefaultDeps } from '../testing/index.js';

function makeAgentWithRegistry() {
  const providerRegistry = new SimpleRagProviderRegistry();
  const mem = new InMemoryRagProvider({ name: 'mem' });
  providerRegistry.registerProvider(mem);

  const registry = new SimpleRagRegistry();
  registry.setProviderRegistry(providerRegistry);

  const { deps } = makeDefaultDeps({ ragRegistry: registry });
  // Ensure ragStores is a live projection of the registry.
  const ragStores: Record<string, import('../interfaces/rag.js').IRag> = {};
  const rebuild = () => {
    for (const k of Object.keys(ragStores)) delete ragStores[k];
    for (const m of registry.list()) {
      const r = registry.get(m.name);
      if (r) ragStores[m.name] = r;
    }
  };
  rebuild();
  registry.setMutationListener(rebuild);
  deps.ragStores = ragStores;

  const agent = new SmartAgent(deps, { maxIterations: 1 });
  return { agent, deps, registry };
}

describe('SmartAgent.closeSession', () => {
  it('removes session-scoped collections with matching sessionId', async () => {
    const { agent, registry } = makeAgentWithRegistry();

    const res = await registry.createCollection({
      providerName: 'mem',
      collectionName: 'session-A',
      scope: 'session',
      sessionId: 'S',
    });
    assert.ok(
      res.ok,
      `createCollection failed: ${!res.ok && res.error.message}`,
    );
    assert.ok(
      registry.get('session-A'),
      'session-A should exist before closeSession',
    );

    await agent.closeSession('S');

    assert.equal(
      registry.get('session-A'),
      undefined,
      'session-A should be removed after closeSession',
    );
  });

  it('preserves global/user collections', async () => {
    const { agent, registry } = makeAgentWithRegistry();

    registry.register('global', new InMemoryRag(), undefined, {
      displayName: 'G',
      scope: 'global',
    });

    await agent.closeSession('NONE');

    assert.ok(
      registry.get('global'),
      'global collection should be preserved after closeSession',
    );
  });
});
