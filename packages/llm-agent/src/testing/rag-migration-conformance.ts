import assert from 'node:assert/strict';
import type {
  RagCatalogDescription,
  RagCollectionRecord,
} from '../interfaces/rag.js';
import type { RagError, Result } from '../interfaces/types.js';

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
  expectedRecords: readonly RagCollectionRecord[];
  invalidStoreNames: readonly string[];
}

export const ragMigrationConformanceCases = [
  {
    name: 'migration is idempotent, preserves existing owners, reports and excludes invalid-owner rows',
    async run(h: RagMigrationConformanceHarness): Promise<void> {
      const first = await h.migrate();
      assert.ok(first.ok);
      assert.deepEqual(
        first.value.reported.map((row) => row.storeName).sort(),
        [...h.invalidStoreNames].sort(),
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
