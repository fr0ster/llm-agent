import assert from 'node:assert/strict';
import { test } from 'node:test';
import { symmetricEmbedder } from '@mcp-abap-adt/llm-agent';
import { conformanceEmbedder } from '@mcp-abap-adt/llm-agent/testing/rag-filter-conformance';
import {
  missingRoleMigrationConformanceCase,
  ragMigrationConformanceCases,
} from '@mcp-abap-adt/llm-agent/testing/rag-migration-conformance';
import { migrateQdrantVectorRagAccess } from '../migrate-access.js';
import { deterministicUUID } from '../qdrant-rag.js';
import { QdrantRagProvider } from '../qdrant-rag-provider.js';
import { type StubPoint, startQdrantStub } from './qdrant-stub.js';

for (const entry of ragMigrationConformanceCases) {
  test(`Qdrant ${entry.name}`, async () => {
    const stub = await startQdrantStub();
    try {
      // Current-release catalog: optional payload keys, no role_id or access collections.
      stub.collections.set('rag_collection_catalog', {
        size: 1,
        points: new Map([
          [
            'u',
            {
              id: 'u',
              vector: [1],
              payload: {
                store_name: 'u',
                collection_name: 'User',
                scope: 'user',
                user_id: 'u1',
              },
            },
          ],
          [
            's',
            {
              id: 's',
              vector: [1],
              payload: {
                store_name: 's',
                collection_name: 'Session',
                scope: 'session',
                session_id: 's1',
              },
            },
          ],
          [
            'g',
            {
              id: 'g',
              vector: [1],
              payload: {
                store_name: 'g',
                collection_name: 'Global',
                scope: 'global',
              },
            },
          ],
          [
            'bad',
            {
              id: 'bad',
              vector: [1],
              payload: {
                store_name: 'bad',
                collection_name: 'Invalid',
                scope: 'user',
              },
            },
          ],
        ]),
      });
      const legacy = stub.collections.get('rag_collection_catalog');
      assert.ok(legacy);
      for (const [key, point] of [...legacy.points]) {
        legacy.points.delete(key);
        const id = await deterministicUUID(key);
        legacy.points.set(id, { ...point, id });
      }
      const provider = new QdrantRagProvider({
        name: 'migration',
        url: stub.baseUrl,
        embedder: symmetricEmbedder(conformanceEmbedder()),
      });
      await entry.run({
        supportsOrphans: true,
        async seedLegacyRecords(records, storeName) {
          stub.collections.set(storeName, {
            size: 1,
            points: new Map(
              records.map((r) => [
                r.id,
                {
                  id: r.id,
                  vector: [1],
                  payload: JSON.parse(
                    JSON.stringify(r.metadata),
                  ) as StubPoint['payload'],
                },
              ]),
            ),
          });
          return storeName;
        },
        async recordMetadata() {
          return ['u', 's', 'missing-catalog'].flatMap((name) =>
            [...(stub.collections.get(name)?.points.values() ?? [])].map(
              (p) => ({ id: String(p.id), metadata: p.payload }),
            ),
          );
        },
        migrate: () => migrateQdrantVectorRagAccess(provider),
        describe: () => provider.describeCollections(),
        snapshot: async () =>
          JSON.stringify(
            [...stub.collections].map(([name, collection]) => ({
              name,
              size: collection.size,
              payloadSchema: collection.payloadSchema ?? {},
              points: [...collection.points],
            })),
          ),
        expectedRecords: [
          { storeName: 'u', name: 'User', scope: 'user', userId: 'u1' },
          {
            storeName: 's',
            name: 'Session',
            scope: 'session',
            sessionId: 's1',
          },
          { storeName: 'g', name: 'Global', scope: 'global' },
        ],
        invalidStoreNames: ['bad'],
      });
      await missingRoleMigrationConformanceCase.run({
        async seedMissingRole() {
          const id = await deterministicUUID('orphan');
          legacy.points.set(id, {
            id,
            vector: [1],
            payload: {
              store_name: 'orphan',
              collection_name: 'Orphan',
              scope: 'role',
              role_id: 'missing',
            },
          });
        },
        migrate: () => migrateQdrantVectorRagAccess(provider),
        describe: () => provider.describeCollections(),
      });
      assert.deepEqual(legacy.payloadSchema, {
        role_id: { data_type: 'keyword' },
      });
      assert.equal(legacy.points.size, 5);
      for (const name of [
        'rag_roles',
        'rag_role_assignments',
        'rag_session_bindings',
      ])
        assert.ok(stub.collections.has(name));
      const catalog = await provider.describeCollections();
      assert.ok(catalog.ok);
      assert.equal(
        catalog.value.records.some((row) => row.storeName === 'orphan'),
        false,
      );
    } finally {
      await stub.close();
    }
  });
}
