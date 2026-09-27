import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FallbackRag,
  InMemoryRag,
  type IRagEditor,
  type IRagProvider,
  RagError,
  SimpleRagProviderRegistry,
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

test('the circuit-breaker wrapping keeps each entry’s scope and owner', async () => {
  const { reg } = threeDocs();
  const handle = await new SmartAgentBuilder({})
    .withMainLlm(makeLlm([{ content: 'ok' }]))
    .setRagRegistry(reg)
    .withCircuitBreaker()
    .build();
  try {
    const user = reg
      .list()
      .find((m) => m.name === 'docs' && m.scope === 'user');
    assert.equal(user?.userId, 'alice', 'not re-registered as a global');
    const session = reg
      .list()
      .find((m) => m.name === 'docs' && m.scope === 'session');
    assert.equal(session?.sessionId, 'S');
    assert.equal(reg.list().length, 3, 'wrapped in place, nothing added');
    assert.ok(handle.ragStores['user/docs'] instanceof FallbackRag);
    assert.ok(handle.ragStores.docs instanceof FallbackRag);
  } finally {
    await handle.close();
  }
});

test('a wrapped hydrated collection keeps its editor, and its delete still reaches its provider', async () => {
  const deleted: string[] = [];
  const provider = {
    name: 'pg',
    kind: 'vector',
    editable: true,
    supportedScopes: ['session', 'user', 'global'],
    createCollection: async () => ({
      ok: false,
      error: new RagError('not expected'),
    }),
    deleteCollection: async (storeName: string) => {
      deleted.push(storeName);
      return { ok: true, value: undefined };
    },
  } as unknown as IRagProvider;
  const providers = new SimpleRagProviderRegistry();
  providers.registerProvider(provider);
  const reg = new SimpleRagRegistry();
  const editor = {} as IRagEditor;
  reg.adopt(
    {
      storeName: 'mine_0123456789ab',
      name: 'mine',
      scope: 'user',
      userId: 'alice',
    },
    new InMemoryRag(),
    editor,
    'pg',
  );
  const handle = await new SmartAgentBuilder({})
    .withMainLlm(makeLlm([{ content: 'ok' }]))
    .setRagRegistry(reg)
    .setRagProviderRegistry(providers)
    .withCircuitBreaker()
    .build();
  try {
    assert.ok(handle.ragStores['user/mine'] instanceof FallbackRag);
    const meta = reg.list().find((m) => m.name === 'mine');
    assert.equal(meta?.providerName, 'pg', 'the provider survives the wrap');
    assert.equal(meta?.userId, 'alice');
    assert.equal(
      reg.getEditor('mine', 'user'),
      editor,
      'still editable through the tools',
    );
    assert.ok((await reg.deleteCollection('mine', 'user')).ok);
    assert.deepEqual(
      deleted,
      ['mine_0123456789ab'],
      'the store name, not the logical one: a delete that missed would leave the record to be hydrated again',
    );
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
