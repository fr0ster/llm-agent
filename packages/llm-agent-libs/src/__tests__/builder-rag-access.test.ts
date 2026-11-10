import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  InMemoryRag,
  type RagCollectionOwner,
  SimpleRagRegistry,
} from '@mcp-abap-adt/llm-agent';
import { testRagAccess } from '@mcp-abap-adt/llm-agent/testing/rag-access-testing';
import { SmartAgentBuilder, unwrapBuilderResult } from '../builder.js';
import { makeLlm } from '../testing/index.js';

test('new SmartAgentBuilder().build() without withRagAccess fails with ragAccess is required', async () => {
  const result = await new SmartAgentBuilder().build();
  assert.equal(result.ok, false);
  if (result.ok) assert.fail('Expected a configuration error');
  assert.equal(result.error.name, 'BuilderConfigError');
  assert.equal(result.error.message, 'ragAccess is required');
});

test("addRagCollection({ name:'x', rag }) without meta.scope fails the build", async () => {
  const result = await new SmartAgentBuilder({ skipModelValidation: true })
    .withRagAccess(testRagAccess())
    .withMainLlm(makeLlm([{ content: 'ok' }]))
    .addRagCollection({ name: 'x', rag: new InMemoryRag() })
    .build();
  assert.equal(result.ok, false);
  if (result.ok) assert.fail('Expected a configuration error');
  assert.equal(result.error.name, 'BuilderConfigError');
});

for (const scope of ['session', 'user', 'role'] as const) {
  test(`addRagCollection requires the ${scope} owner identifier`, async () => {
    const result = await new SmartAgentBuilder({ skipModelValidation: true })
      .withRagAccess(testRagAccess())
      .withMainLlm(makeLlm([{ content: 'ok' }]))
      .addRagCollection({
        name: 'x',
        rag: new InMemoryRag(),
        meta: { displayName: 'x', scope },
      })
      .build();
    assert.equal(result.ok, false);
    if (result.ok) assert.fail('Expected a configuration error');
    assert.equal(result.error.name, 'BuilderConfigError');
  });
}

const owners: RagCollectionOwner[] = [
  { scope: 'global' },
  { scope: 'session', sessionId: 'session-a' },
  { scope: 'user', userId: 'user-a' },
  { scope: 'role', roleId: 'role-a' },
];

for (const owner of owners) {
  for (const name of ['history', 'tools']) {
    test(`reserved ${name} in ${owner.scope} fails before registry mutation`, async () => {
      const registry = new SimpleRagRegistry();
      const result = await new SmartAgentBuilder({ skipModelValidation: true })
        .withRagAccess(testRagAccess())
        .withMainLlm(makeLlm([{ content: 'ok' }]))
        .setRagRegistry(registry)
        .addRagCollection({
          name: 'valid',
          rag: new InMemoryRag(),
          meta: { displayName: 'valid', scope: 'global' },
        })
        .addRagCollection({
          name,
          rag: new InMemoryRag(),
          meta: { displayName: name, ...owner },
        })
        .build();
      if (result.ok) await result.value.close();
      assert.equal(result.ok, false);
      if (result.ok) assert.fail('Expected reserved name refusal');
      assert.equal(result.error.name, 'ReservedCollectionNameError');
      assert.deepEqual(registry.list(), []);
    });
  }
}

for (const owner of owners) {
  test(`addRagCollection preserves an explicit ${owner.scope} owner`, async () => {
    const rag = new InMemoryRag();
    const result = await new SmartAgentBuilder({ skipModelValidation: true })
      .withRagAccess(testRagAccess())
      .withMainLlm(makeLlm([{ content: 'ok' }]))
      .addRagCollection({
        name: 'x',
        rag,
        meta: { displayName: 'x', ...owner },
      })
      .build();
    assert.ok(result.ok);
    try {
      const store =
        result.value.ragStores[
          owner.scope === 'global' ? 'x' : `${owner.scope}/x`
        ];
      assert.deepEqual(store.owner, owner);
      assert.equal(store.rag, rag);
    } finally {
      await result.value.close();
    }
  });
}

test('invalid collection ownership fails before model calls or registry mutations', async () => {
  const registry = new SimpleRagRegistry();
  let modelCalls = 0;
  const llm = makeLlm([{ content: 'ok' }]);
  const result = await new SmartAgentBuilder()
    .withRagAccess(testRagAccess())
    .withMainLlm({
      ...llm,
      chat: async (...args) => {
        modelCalls++;
        return llm.chat(...args);
      },
    })
    .setRagRegistry(registry)
    .addRagCollection({
      name: 'valid',
      rag: new InMemoryRag(),
      meta: { displayName: 'Valid', scope: 'global' },
    })
    .addRagCollection({ name: 'invalid', rag: new InMemoryRag() })
    .build();
  assert.equal(result.ok, false);
  assert.equal(modelCalls, 0);
  assert.deepEqual(registry.list(), []);
});

test('whitespace-only owner identifiers fail the build', async () => {
  const result = await new SmartAgentBuilder({ skipModelValidation: true })
    .withRagAccess(testRagAccess())
    .withMainLlm(makeLlm([{ content: 'ok' }]))
    .addRagCollection({
      name: 'x',
      rag: new InMemoryRag(),
      meta: { displayName: 'x', scope: 'session', sessionId: ' ' },
    })
    .build();
  if (result.ok) await result.value.close();
  assert.equal(result.ok, false);
});

test('a built handle projects tools as internal', async () => {
  const result = await new SmartAgentBuilder({ skipModelValidation: true })
    .withRagAccess(testRagAccess())
    .withMainLlm(makeLlm([{ content: 'ok' }]))
    .setToolsRag(new InMemoryRag())
    .build();
  assert.ok(result.ok);
  try {
    assert.equal(result.value.ragStores.tools.owner.scope, 'internal');
  } finally {
    await result.value.close();
  }
});

test('idempotency cannot reuse a collection belonging to another session', async () => {
  const registry = new SimpleRagRegistry();
  registry.register('x', new InMemoryRag(), undefined, {
    displayName: 'x',
    scope: 'session',
    sessionId: 'session-a',
  });
  await assert.rejects(async () => {
    const handle = await new SmartAgentBuilder({ skipModelValidation: true })
      .withRagAccess(testRagAccess())
      .withMainLlm(makeLlm([{ content: 'ok' }]))
      .setRagRegistry(registry)
      .addRagCollection({
        name: 'x',
        rag: new InMemoryRag(),
        idempotent: true,
        meta: { displayName: 'x', scope: 'session', sessionId: 'session-b' },
      })
      .build()
      .then(unwrapBuilderResult);
    await handle.close();
  }, /already registered/);
});

test('built history is per-request session owned, isolated and inaccessible through collection tools', async () => {
  const rag = new InMemoryRag();
  for (const sessionId of ['A', 'B']) {
    const inserted = await rag
      .writer()
      .upsertRaw(sessionId, `record ${sessionId}`, { sessionId });
    assert.ok(inserted.ok);
  }
  const access = testRagAccess();
  let decisions = 0;
  access.decision.canRead = async () => {
    decisions++;
    return false;
  };
  const handle = unwrapBuilderResult(
    await new SmartAgentBuilder({ skipModelValidation: true })
      .withRagAccess(access)
      .withMainLlm(makeLlm([{ content: 'ok' }]))
      .setToolsRag(new InMemoryRag())
      .setHistoryRag(rag)
      .build(),
  );
  try {
    assert.deepEqual(handle.ragStores.history.owner, {
      scope: 'session',
      perRequest: true,
    });
    assert.equal(handle.ragStores.tools.owner.scope, 'internal');
    const { ownerBoundQuery } = await import('../rag/owner-bound-query.js');
    const { TextOnlyEmbedding, buildRagCollectionToolEntries } = await import(
      '@mcp-abap-adt/llm-agent'
    );
    const embedding = new TextOnlyEmbedding('record');
    const caller = { sessionId: 'A', userId: 'alice', isAdmin: false };
    await access.bindings.bind('A', 'alice');
    await access.bindings.bind('B', 'alice');
    access.decision.canRead = async () => {
      decisions++;
      return true;
    };
    const result = await ownerBoundQuery(
      handle.ragStores.history,
      embedding,
      10,
      { caller },
      access,
    );
    assert.ok(result.ok);
    assert.deepEqual(
      result.value.map((r) => r.metadata.sessionId),
      ['A'],
    );
    for (const options of [{}, { caller, ragFilter: { sessionId: 'B' } }]) {
      const refused = await ownerBoundQuery(
        handle.ragStores.history,
        embedding,
        10,
        options,
        access,
      );
      assert.equal(refused.ok, false);
    }
    const other = await ownerBoundQuery(
      handle.ragStores.history,
      embedding,
      10,
      { caller: { ...caller, sessionId: 'B' } },
      access,
    );
    assert.ok(other.ok);
    assert.deepEqual(
      other.value.map((r) => r.metadata.sessionId),
      ['B'],
    );
    assert.equal(decisions, 2);
    for (const isAdmin of [false, true]) {
      const entries = buildRagCollectionToolEntries({
        registry: handle.ragRegistry,
        caller: { ...caller, isAdmin },
        access: testRagAccess(),
      });
      const list = entries.find(
        (e) => e.toolDefinition.name === 'rag_list_collections',
      );
      assert.ok(list);
      const listed = await list.handler({}, {});
      assert.equal(JSON.stringify(listed).includes('history'), false);
      for (const scope of ['session', 'user', 'role', 'global']) {
        for (const name of [
          'rag_describe_collection',
          'rag_add',
          'rag_delete_collection',
        ]) {
          const entry = entries.find((e) => e.toolDefinition.name === name);
          assert.ok(entry);
          const refused = await entry.handler(
            {},
            {
              name: 'history',
              collection: 'history',
              scope,
              text: 'changed',
              canonicalKey: 'changed',
            },
          );
          assert.ok(
            typeof refused === 'object' && refused !== null && 'ok' in refused,
          );
          assert.equal(refused.ok, false);
        }
      }
    }
    const unchanged = await rag.query(embedding, 10);
    assert.ok(unchanged.ok);
    assert.equal(unchanged.value.length, 2);
  } finally {
    await handle.close();
  }
});

test('history retains circuit-breaker decoration across registry projection rebuilds', async () => {
  const { FallbackRag } = await import('@mcp-abap-adt/llm-agent');
  const registry = new SimpleRagRegistry();
  const handle = unwrapBuilderResult(
    await new SmartAgentBuilder({ skipModelValidation: true })
      .withRagAccess(testRagAccess())
      .withMainLlm(makeLlm([{ content: 'ok' }]))
      .setRagRegistry(registry)
      .setHistoryRag(new InMemoryRag())
      .withCircuitBreaker()
      .build(),
  );
  try {
    assert.ok(handle.ragStores.history.rag instanceof FallbackRag);
    registry.register('later', new InMemoryRag(), undefined, {
      displayName: 'later',
      scope: 'global',
    });
    assert.ok(handle.ragStores.history.rag instanceof FallbackRag);
    assert.deepEqual(handle.ragStores.history.owner, {
      scope: 'session',
      perRequest: true,
    });
    assert.equal(
      registry.list().some((m) => m.name === 'history'),
      false,
    );
  } finally {
    await handle.close();
  }
});
