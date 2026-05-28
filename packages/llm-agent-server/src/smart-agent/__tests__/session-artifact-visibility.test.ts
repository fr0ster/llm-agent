import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  GlobalUniqueIdStrategy,
  InMemoryRagProvider,
  SessionScopedEditStrategy,
  SimpleRagProviderRegistry,
  SimpleRagRegistry,
  TextOnlyEmbedding,
} from '@mcp-abap-adt/llm-agent';

test('session artifact written via shared registry is visible under its sessionId, isolated from another', async () => {
  const providers = new SimpleRagProviderRegistry();
  providers.registerProvider(new InMemoryRagProvider({ name: 'mem' }));
  const reg = new SimpleRagRegistry();
  reg.setProviderRegistry(providers);

  // Create a session-scoped collection for s1 (as the SessionGraph would).
  const created = await reg.createCollection({
    providerName: 'mem',
    collectionName: 'session-artifacts',
    scope: 'session',
    sessionId: 's1',
  });
  assert.ok(
    created.ok,
    `createCollection failed: ${!created.ok && created.error.message}`,
  );

  // Get the raw store and its editor.
  const store = reg.get('session-artifacts');
  assert.ok(store, 'store present');

  // Wrap the store writer with SessionScopedEditStrategy so documents are stamped with sessionId.
  const writer = store.writer?.();
  assert.ok(writer, 'writer available');
  const scopedEditor = new SessionScopedEditStrategy(
    writer,
    's1',
    new GlobalUniqueIdStrategy(),
  );

  // Upsert a doc via the session-scoped editor.
  const up = await scopedEditor.upsert('a session-scoped skill artifact', {});
  assert.ok(up.ok, `upsert failed: ${!up.ok && up.error.message}`);

  // Query with ragFilter.sessionId. InMemoryRag filters by sessionId when provided.
  const hit = await store.query(new TextOnlyEmbedding('skill'), 10, {
    ragFilter: { sessionId: 's1' },
  });
  const miss = await store.query(new TextOnlyEmbedding('skill'), 10, {
    ragFilter: { sessionId: 's2' },
  });

  assert.ok(
    hit.ok && hit.value.length === 1,
    'visible under matching sessionId',
  );
  assert.ok(
    miss.ok && miss.value.length === 0,
    'isolated under different sessionId',
  );
});
