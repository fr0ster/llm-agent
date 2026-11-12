import assert from 'node:assert/strict';
import { test } from 'node:test';
import { staticLogin, symmetricEmbedder } from '@mcp-abap-adt/llm-agent';
import { ragAccessStoreConformanceCases } from '@mcp-abap-adt/llm-agent/testing/rag-access-store-conformance';
import { createHanaVectorRagAccessStores } from '../access-stores.js';
import { HanaVectorRagProvider } from '../hana-vector-rag-provider.js';
import { migrateHanaVectorRagAccess } from '../migrate-access.js';
import { accessFixture } from './access-fixture.js';

for (const layout of ['per-collection', 'shared'] as const) {
  for (const item of ragAccessStoreConformanceCases) {
    test(`Hana ${layout} ${item.name}`, async () => {
      const { provider, db } = accessFixture(layout);
      assert.ok((await migrateHanaVectorRagAccess(provider)).ok);
      await item.run(async () => ({
        ...createHanaVectorRagAccessStores(provider),
        independentStores: async () =>
          createHanaVectorRagAccessStores(
            new HanaVectorRagProvider({
              name: 'other',
              catalogTable: 'rag_collection_catalog',
              connection: {
                collectionName: 'unused',
                credential: staticLogin('u', 'p'),
              },
              embedder: symmetricEmbedder({
                embed: async () => ({ vector: [1, 0, 0] }),
              }),
              clientFactory: () => ({ ...db.client }),
            }),
          ),
        deleteCollection: (name: string) => provider.deleteCollection(name),
        async createCollection(name: string) {
          const result = await provider.createCollection(name, {
            scope: 'user',
            userId: 'owner',
            dimension: 3,
          });
          return result.ok ? { ok: true as const, value: undefined } : result;
        },
      }));
    });
  }
}

test('HANA two binding stores persist exactly one concurrent winner', async () => {
  const { provider } = accessFixture();
  assert.ok((await migrateHanaVectorRagAccess(provider)).ok);
  const { HanaVectorRagProvider } = await import(
    '../hana-vector-rag-provider.js'
  );
  const { staticLogin, symmetricEmbedder } = await import(
    '@mcp-abap-adt/llm-agent'
  );
  const client = (await provider.accessPersistence()).client;
  const other = new HanaVectorRagProvider({
    name: 'other',
    connection: { collectionName: 'unused', credential: staticLogin('u', 'p') },
    embedder: symmetricEmbedder({ embed: async () => ({ vector: [1, 0, 0] }) }),
    clientFactory: () => ({ ...client }),
  });
  const a = createHanaVectorRagAccessStores(provider);
  const b = createHanaVectorRagAccessStores(other);
  const results = await Promise.all([
    a.bindings.bind('s', 'u1'),
    b.bindings.bind('s', 'u2'),
  ]);
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.ok(
    (
      await createHanaVectorRagAccessStores(provider).bindings.bind(
        's',
        results[0].ok ? 'u1' : 'u2',
      )
    ).ok,
  );
});
