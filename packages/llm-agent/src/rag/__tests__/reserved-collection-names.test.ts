import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RagCollectionOwner } from '../../interfaces/rag.js';
import { testRagAccess } from '../../testing/rag-access-testing.js';
import { ReservedCollectionNameError } from '../corrections/errors.js';
import { InMemoryRag } from '../in-memory-rag.js';
import { buildRagAdminToolEntries } from '../mcp-tools/rag-admin-tools.js';
import { buildRagCollectionToolEntries } from '../mcp-tools/rag-collection-tools.js';
import { InMemoryRagProvider } from '../providers/in-memory-rag-provider.js';
import { SimpleRagProviderRegistry } from '../providers/simple-provider-registry.js';
import { TextOnlyEmbedding } from '../query-embedding.js';
import { SimpleRagRegistry } from '../registry/simple-rag-registry.js';

const owners: RagCollectionOwner[] = [
  { scope: 'global' },
  { scope: 'session', sessionId: 'S' },
  { scope: 'user', userId: 'alice' },
  { scope: 'role', roleId: 'R' },
];
for (const owner of owners) {
  for (const name of ['history', 'tools']) {
    test(`registry refuses registration, adoption and creation of ${owner.scope}/${name}`, async () => {
      const registry = new SimpleRagRegistry();
      assert.throws(
        () =>
          registry.register(name, new InMemoryRag(), undefined, {
            displayName: name,
            ...owner,
          }),
        ReservedCollectionNameError,
      );
      assert.throws(
        () =>
          registry.adopt(
            { name, storeName: 'stored', ...owner },
            new InMemoryRag(),
          ),
        ReservedCollectionNameError,
      );
      const result = await registry.createCollection({
        collectionName: name,
        providerName: 'mem',
        ...owner,
      });
      assert.ok(
        !result.ok && result.error instanceof ReservedCollectionNameError,
      );
      assert.deepEqual(registry.list(), []);
    });
  }
}

test('creation tools refuse reserved names', async () => {
  const registry = new SimpleRagRegistry();
  const providerRegistry = new SimpleRagProviderRegistry();
  providerRegistry.registerProvider(
    new InMemoryRagProvider({
      name: 'mem',
      supportedScopes: ['session', 'global'],
    }),
  );
  registry.setProviderRegistry(providerRegistry);
  const options = {
    registry,
    providerRegistry,
    caller: { sessionId: 'S', userId: 'alice', isAdmin: true },
    access: testRagAccess(),
  };
  const entries = [
    ...buildRagCollectionToolEntries(options),
    ...buildRagAdminToolEntries(options),
  ];
  for (const name of ['history', 'tools']) {
    for (const toolName of [
      'rag_create_collection',
      'rag_create_shared_collection',
    ]) {
      const entry = entries.find((e) => e.toolDefinition.name === toolName);
      assert.ok(entry);
      const result = await entry.handler(
        {},
        toolName === 'rag_create_collection'
          ? { name, provider: 'mem', scope: 'global' }
          : { collectionName: name, providerName: 'mem', scope: 'global' },
      );
      assert.ok(
        typeof result === 'object' &&
          result !== null &&
          'ok' in result &&
          'code' in result,
      );
      assert.equal(result.ok, false);
      assert.equal(result.code, 'RAG_RESERVED_COLLECTION_NAME');
    }
  }
  assert.deepEqual(registry.list(), []);
});

test('collection tools cannot list or resolve reserved entries from a foreign registry', async () => {
  const rag = new InMemoryRag();
  await rag.writer().upsertRaw('original', 'original', {});
  class ForeignRegistry extends SimpleRagRegistry {
    constructor() {
      super();
      for (const name of ['history', 'tools']) {
        this.entries.set(name, {
          rag,
          storeName: name,
          meta: { name, displayName: name, editable: true, scope: 'global' },
        });
      }
    }
    override list() {
      return ['history', 'tools'].map((name) => ({
        name,
        displayName: name,
        editable: true,
        scope: 'global' as const,
      }));
    }
    override get(): ReturnType<SimpleRagRegistry['get']> {
      assert.fail('reserved store must never be resolved');
    }
    override getEditor(): ReturnType<SimpleRagRegistry['getEditor']> {
      assert.fail('reserved editor must never be resolved');
    }
    override async deleteCollection(): ReturnType<
      SimpleRagRegistry['deleteCollection']
    > {
      assert.fail('reserved store must never be deleted');
    }
  }
  const entries = buildRagCollectionToolEntries({
    registry: new ForeignRegistry(),
    caller: { sessionId: 'S', userId: 'alice', isAdmin: true },
    access: testRagAccess(),
  });
  for (const entry of entries) {
    for (const name of ['history', 'tools']) {
      const result = await entry.handler(
        {},
        { name, collection: name, text: 'changed', canonicalKey: 'changed' },
      );
      assert.ok(
        typeof result === 'object' && result !== null && 'ok' in result,
      );
      if (entry.toolDefinition.name === 'rag_list_collections') {
        assert.ok('collections' in result);
        assert.deepEqual(result.collections, []);
      } else assert.equal(result.ok, false);
    }
  }
  const result = await rag.query(new TextOnlyEmbedding('original'), 10);
  assert.ok(result.ok);
  assert.deepEqual(
    result.value.map((record) => record.text),
    ['original'],
  );
});
