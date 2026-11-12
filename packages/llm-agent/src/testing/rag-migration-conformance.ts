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
import { conflictingOwnerRecords } from './rag-filter-conformance.js';

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
  supportsOrphans?: boolean;
  seedLegacyRecords(
    records: readonly { id: string; metadata: RagMetadata }[],
    storeName: string,
  ): Promise<string>;
  recordMetadata(): Promise<readonly { id: string; metadata: RagMetadata }[]>;
  expectedRecords: readonly RagCollectionRecord[];
  invalidStoreNames: readonly string[];
}

export const ragMigrationConformanceCases = [
  {
    name: 'migration is idempotent, preserves existing owners, reports and excludes invalid-owner rows',
    async run(h: RagMigrationConformanceHarness): Promise<void> {
      const user = h.expectedRecords.find((r) => r.scope === 'user');
      const session = h.expectedRecords.find((r) => r.scope === 'session');
      assert.ok(user?.scope === 'user');
      assert.ok(session?.scope === 'session');
      const legacyRoleMetadata: RagMetadata = { id: 'legacy-role-record' };
      Object.assign(legacyRoleMetadata, {
        ownerScope: 'role',
        roleId: 'legacy-role',
      });
      const recordStore = await h.seedLegacyRecords(
        [
          { id: 'empty-user', metadata: { title: 'preserved' } },
          { id: 'legacy-role-record', metadata: legacyRoleMetadata },
          ...Array.from({ length: 513 }, (_, index) => ({
            id: `batch-${String(index).padStart(4, '0')}`,
            metadata: {},
          })),
          { id: 'matching-user', metadata: { userId: user.userId } },
          { id: 'conflict-record', metadata: { userId: 'conflicting-user' } },
          ...conflictingOwnerRecords,
        ],
        user.storeName,
      );
      await h.seedLegacyRecords(
        [
          { id: 'empty-session', metadata: {} },
          {
            id: 'matching-session',
            metadata: { sessionId: session.sessionId },
          },
        ],
        session.storeName,
      );
      if (h.supportsOrphans)
        await h.seedLegacyRecords(
          [{ id: 'orphan-record', metadata: { userId: 'orphan-user' } }],
          'missing-catalog',
        );
      const first = await h.migrate();
      assert.ok(first.ok);
      assert.deepEqual(
        first.value.reported.map((row) => row.storeName).sort(),
        [
          ...h.invalidStoreNames,
          ...Array<string>(2 + conflictingOwnerRecords.length).fill(
            recordStore,
          ),
          ...(h.supportsOrphans ? ['missing-catalog'] : []),
        ].sort(),
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
                : {}),
          }))
          .sort((a, b) => a.storeName.localeCompare(b.storeName));
      assert.deepEqual(
        owners(description.value.records),
        owners(h.expectedRecords),
      );
      const records = await h.recordMetadata();
      for (const id of ['empty-user', 'matching-user']) {
        const metadata = records.find((r) => r.id === id)?.metadata;
        assert.equal(metadata?.ownerScope, 'user');
        assert.equal(metadata?.userId, user.userId);
      }
      for (const id of ['empty-session', 'matching-session']) {
        const metadata = records.find((r) => r.id === id)?.metadata;
        assert.equal(metadata?.ownerScope, 'session');
        assert.equal(metadata?.sessionId, session.sessionId);
      }
      if (h.supportsOrphans) {
        const metadata = records.find(
          (r) => r.id === 'orphan-record',
        )?.metadata;
        assert.equal(metadata?.ownerScope, 'user');
        assert.equal(metadata?.userId, 'orphan-user');
      }
      assert.equal(
        records.find((r) => r.id === 'empty-user')?.metadata.title,
        'preserved',
      );
      for (const record of records.filter((r) => r.id.startsWith('batch-'))) {
        assert.equal(record.metadata.ownerScope, 'user');
        assert.equal(record.metadata.userId, user.userId);
      }
      assert.equal(
        records.filter((r) => r.id.startsWith('batch-')).length,
        513,
      );
      assert.deepEqual(
        records.find((row) => row.id === 'legacy-role-record')?.metadata,
        legacyRoleMetadata,
      );
      const conflict = records.find((r) => r.id === 'conflict-record');
      assert.ok(conflict);
      assert.equal(conflict.metadata.ownerScope, 'invalid');
      for (const record of conflictingOwnerRecords)
        assert.equal(
          records.find((r) => r.id === record.id)?.metadata.ownerScope,
          'invalid',
        );
      for (const filter of [
        { sessionId: 's1' },
        { userId: 'u1' },
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

/** Shared orphan-role acceptance case, including process-local catalogs. */
export const missingRoleMigrationConformanceCase = {
  name: 'migration reports and preserves legacy role-owned collections',
  async run(h: {
    seedMissingRole(): Promise<void>;
    migrate(): Promise<
      Result<
        { reported: readonly { storeName: string; reason: string }[] },
        RagError
      >
    >;
    describe(): Promise<Result<RagCatalogDescription, RagError>>;
  }): Promise<void> {
    await h.seedMissingRole();
    const migration = await h.migrate();
    assert.ok(migration.ok);
    assert.deepEqual(
      migration.value.reported.filter((row) => row.storeName === 'orphan'),
      [
        {
          storeName: 'orphan',
          reason: 'Legacy role owner; administrative resolution required',
        },
      ],
    );
    assert.deepEqual(await h.migrate(), migration);
    const description = await h.describe();
    assert.ok(description.ok);
    assert.equal(
      description.value.records.some((row) => row.storeName === 'orphan'),
      false,
    );
    assert.deepEqual(
      description.value.rejected.filter((row) => row.storeName === 'orphan'),
      [
        {
          storeName: 'orphan',
          reason: 'Legacy role owner; administrative resolution required',
        },
      ],
    );
  },
};
