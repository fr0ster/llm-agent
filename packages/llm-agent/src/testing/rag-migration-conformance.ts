import assert from 'node:assert/strict';
import type {
  RagCatalogDescription,
  RagCollectionRecord,
} from '../interfaces/rag.js';
import type { RagError, RagMetadata, Result } from '../interfaces/types.js';
import {
  matchesRagIdentity,
  ragIdentityFilter,
} from '../rag/identity-filter.js';

export interface RagMigrationConformanceHarness {
  /** A current-release catalog with valid and invalid owners, prepared by the backend. */
  migrate(): Promise<
    Result<
      { reported: readonly { storeName: string; reason: string }[] },
      RagError
    >
  >;
  describe(): Promise<Result<RagCatalogDescription, RagError>>;
  /** Stable serialization of persisted rows AND schema, including invalid rows. */
  snapshot(): Promise<string>;
  seedLegacyRecords(
    records: readonly { id: string; metadata: RagMetadata }[],
  ): Promise<string>;
  recordMetadata(): Promise<readonly { id: string; metadata: RagMetadata }[]>;
  expectedRecords: readonly RagCollectionRecord[];
  invalidStoreNames: readonly string[];
}

export const ragMigrationConformanceCases = [
  {
    name: 'migration is idempotent, preserves existing owners, reports and excludes invalid-owner rows',
    async run(h: RagMigrationConformanceHarness): Promise<void> {
      const recordStore = await h.seedLegacyRecords([
        { id: 'session-record', metadata: { sessionId: 's1' } },
        { id: 'user-record', metadata: { userId: 'u1' } },
        { id: 'role-record', metadata: { roleId: 'r1' } },
        { id: 'global-record', metadata: {} },
        { id: 'conflict-record', metadata: { sessionId: 's1', userId: 'u1' } },
      ]);
      const first = await h.migrate();
      assert.ok(first.ok);
      assert.deepEqual(
        first.value.reported.map((row) => row.storeName).sort(),
        [...h.invalidStoreNames, recordStore].sort(),
      );
      for (const row of first.value.reported) assert.ok(row.reason.length > 0);
      const description = await h.describe();
      assert.ok(description.ok);
      const owners = (records: readonly RagCollectionRecord[]) =>
        records
          .map((record) => ({
            storeName: record.storeName,
            scope: record.scope,
            ...(record.scope === 'session'
              ? { sessionId: record.sessionId }
              : record.scope === 'user'
                ? { userId: record.userId }
                : record.scope === 'role'
                  ? { roleId: record.roleId }
                  : {}),
          }))
          .sort((a, b) => a.storeName.localeCompare(b.storeName));
      assert.deepEqual(
        owners(description.value.records),
        owners(h.expectedRecords),
      );
      const records = await h.recordMetadata();
      assert.equal(records.length, 5);
      for (const [id, scope] of [
        ['session-record', 'session'],
        ['user-record', 'user'],
        ['role-record', 'role'],
        ['global-record', 'global'],
      ] as const) {
        assert.equal(
          records.find((r) => r.id === id)?.metadata.ownerScope,
          scope,
        );
      }
      const conflict = records.find((r) => r.id === 'conflict-record');
      assert.ok(conflict);
      assert.equal(conflict.metadata.ownerScope, undefined);
      for (const filter of [
        { sessionId: 's1' },
        { userId: 'u1' },
        { roleId: 'r1' },
        { owner: { scope: 'global' as const } },
      ])
        assert.equal(
          matchesRagIdentity(
            conflict.metadata,
            ragIdentityFilter({ ragFilter: filter }),
          ),
          false,
        );
      const snapshot = await h.snapshot();
      assert.deepEqual(await h.migrate(), first);
      assert.equal(
        await h.snapshot(),
        snapshot,
        'second migration must change neither rows nor schema',
      );
      assert.deepEqual(await h.describe(), description);
    },
  },
] as const;
