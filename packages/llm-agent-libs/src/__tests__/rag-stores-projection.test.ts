import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CircuitBreakerLlm,
  InMemoryRag,
  SimpleRagRegistry,
} from '@mcp-abap-adt/llm-agent';
import { SmartAgent } from '../agent.js';
import { SmartAgentBuilder } from '../builder.js';
import { makeDefaultDeps, makeLlm, makeRag } from '../testing/index.js';

function threeDocs() {
  const reg = new SimpleRagRegistry();
  const g = new InMemoryRag();
  const u = new InMemoryRag();
  const s = new InMemoryRag();
  reg.register('docs', g, undefined, { displayName: 'docs', scope: 'global' });
  reg.register('docs', u, undefined, {
    displayName: 'docs',
    scope: 'user',
    userId: 'alice',
  });
  reg.register('docs', s, undefined, {
    displayName: 'docs',
    scope: 'session',
    sessionId: 'S',
  });
  return { reg, g, u, s };
}

test('the projection keys a global by its name and an owned collection by scope/name', async () => {
  const { reg, g, u, s } = threeDocs();
  const handle = await new SmartAgentBuilder({})
    .withMainLlm(makeLlm([{ content: 'ok' }]))
    .setRagRegistry(reg)
    .build();
  try {
    assert.equal(handle.ragStores.docs, g);
    assert.equal(handle.ragStores['user/docs'], u);
    assert.equal(handle.ragStores['session/docs'], s);

    // live: a collection added after build appears under its key
    const later = new InMemoryRag();
    reg.register('notes', later, undefined, {
      displayName: 'notes',
      scope: 'session',
      sessionId: 'S',
    });
    assert.equal(handle.ragStores['session/notes'], later);
    reg.unregister('notes', 'session');
    assert.equal(handle.ragStores['session/notes'], undefined);
  } finally {
    await handle.close();
  }
});

test('withCircuitBreaker wraps no store: every entry and projected store stays as registered; only the LLM breaker (D68)', async () => {
  const { reg, g, u, s } = threeDocs();
  const before = reg.list();
  const handle = await new SmartAgentBuilder({})
    .withMainLlm(makeLlm([{ content: 'ok' }]))
    .setRagRegistry(reg)
    .withCircuitBreaker()
    .build();
  try {
    assert.deepEqual(
      reg.list(),
      before,
      'scope, owner and provider unchanged; nothing added',
    );
    assert.equal(
      reg.get('docs', 'global'),
      g,
      'the registry entry is the store registered',
    );
    assert.equal(handle.ragStores.docs, g);
    assert.equal(handle.ragStores['user/docs'], u);
    assert.equal(handle.ragStores['session/docs'], s);
    assert.equal(handle.circuitBreakers.length, 1, 'the main-LLM breaker only');
    assert.ok(handle.agent.currentMainLlm instanceof CircuitBreakerLlm);
  } finally {
    await handle.close();
  }
});

test('a user collection named "tools" does not hide or break the built-in tools store', async () => {
  const reg = new SimpleRagRegistry();
  const mine = new InMemoryRag();
  reg.register('tools', mine, undefined, {
    displayName: 'tools',
    scope: 'user',
    userId: 'alice',
  });
  const toolsRag = new InMemoryRag();
  const handle = await new SmartAgentBuilder({})
    .withMainLlm(makeLlm([{ content: 'ok' }]))
    .setRagRegistry(reg)
    .setToolsRag(toolsRag)
    .build();
  try {
    assert.equal(
      reg.get('tools', 'global'),
      toolsRag,
      'the built-in is registered as the global',
    );
    assert.equal(handle.ragStores.tools, toolsRag);
    assert.equal(handle.ragStores['user/tools'], mine);
  } finally {
    await handle.close();
  }
});

test('addRagStore / removeRagStore address the global and leave a user collection of that name', () => {
  const reg = new SimpleRagRegistry();
  const mine = new InMemoryRag();
  reg.register('kb', mine, undefined, {
    displayName: 'kb',
    scope: 'user',
    userId: 'alice',
  });
  const { deps } = makeDefaultDeps({ ragRegistry: reg });
  const agent = new SmartAgent(deps, { maxIterations: 5 });

  const store = makeRag([]);
  agent.addRagStore('kb', store);
  assert.equal(reg.get('kb', 'global'), store);
  assert.equal(
    reg.get('kb', 'user'),
    mine,
    'the user collection was not unregistered',
  );

  agent.removeRagStore('kb');
  assert.equal(reg.get('kb', 'global'), undefined);
  assert.equal(reg.get('kb', 'user'), mine);
});

test('withCircuitBreakers and replaceRag are gone (D68)', () => {
  assert.equal('withCircuitBreakers' in SmartAgentBuilder.prototype, false);
  assert.equal('replaceRag' in SimpleRagRegistry.prototype, false);
});
