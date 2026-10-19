/**
 * Conformance kit for `IRagScanner.scan`, `IRagFilteredDeleter.deleteWhere`
 * and `IRagCatalogUpdater.updateCollection`.
 *
 * The contract:
 *
 * - `scan` pages cover every record of the collection exactly once, expired
 *   records included; a page holds at most `pageSize` records and may be
 *   short or empty; only a missing `cursor` ends a scan; no vectors;
 * - an insert between two pages never makes the scan skip or repeat a record
 *   that existed when the scan started;
 * - the `userId` / `sessionId` / `namespace` filter is strict string equality:
 *   `123` (a number) never matches `'123'`, `'U1'` never matches `'u1'`;
 * - `deleteWhere` deletes exactly the matching records (expired included),
 *   returns how many, refuses an empty filter with `INVALID_ARGUMENT`, and
 *   never reaches another collection of the same backend storage;
 * - a scanned id round-trips through `getById` and `deleteByIdRaw`;
 * - `updateCollection` replaces `attributes` as a whole and keeps `storeName`,
 *   `scope` and the owner; a missing record is `RAG_COLLECTION_NOT_FOUND`; an
 *   empty patch is `INVALID_ARGUMENT`.
 *
 * Framework-agnostic: each case throws (`node:assert`) on a violation. A case
 * whose seam (`sibling`, `catalog`) the subject does not offer throws
 * {@link ScanDeleteCaseSkipped}; a runner reports it as skipped, never as
 * passed:
 *
 * ```ts
 * for (const c of scanDeleteConformanceCases) {
 *   it(c.name, async (t) => {
 *     try {
 *       await c.run(async () => mySubject());
 *     } catch (err) {
 *       if (!isScanDeleteCaseSkipped(err)) throw err;
 *       t.skip(err.message);
 *     }
 *   });
 * }
 * ```
 *
 * Every case asks the factory for a FRESH subject over empty storage, seeds it
 * through `writer().upsertRaw` (always with an id) and embeds with
 * {@link conformanceEmbedder}.
 */

import assert from 'node:assert/strict';
import type {
  IRag,
  IRagProvider,
  RagCollectionRecord,
} from '../interfaces/rag.js';
import {
  INVALID_ARGUMENT,
  type IRagCatalogUpdater,
  type IRagFilteredDeleter,
  type IRagScanner,
  RAG_COLLECTION_NOT_FOUND,
  type RagScanFilter,
  type RagScanRecord,
} from '../interfaces/rag-scan.js';

export {
  CONFORMANCE_EMBEDDING_DIM,
  conformanceEmbedder,
} from './rag-filter-conformance.js';

/** A store under test: reads, writes, scans and deletes by filter. */
export type ScanDeleteStore = IRag & IRagScanner & IRagFilteredDeleter;

/** One backend: a store, and optionally a sibling collection and a catalog. */
export interface ScanDeleteSubject {
  store(): Promise<ScanDeleteStore>;
  /**
   * Another collection on the same backend storage (shared layout). Absent →
   * the sibling case is skipped.
   */
  sibling?(): Promise<ScanDeleteStore>;
  /**
   * A provider with a catalog, and a way to create a catalog record named
   * `name` through it. Absent → the catalog cases are skipped.
   */
  catalog?(): Promise<{
    provider: IRagProvider & IRagCatalogUpdater;
    create(name: string): Promise<void>;
  }>;
}

/** The seam a case needs beyond `store()`. */
export type ScanDeleteSeam = 'sibling' | 'catalog';

export interface ScanDeleteConformanceCase {
  readonly name: string;
  /** Present when the case needs a seam; it is skipped when the seam is absent. */
  readonly requires?: ScanDeleteSeam;
  run(makeSubject: () => Promise<ScanDeleteSubject>): Promise<void>;
}

/** Thrown by a case whose seam the subject does not offer: report as skipped. */
export class ScanDeleteCaseSkipped extends Error {
  readonly seam: ScanDeleteSeam;
  constructor(seam: ScanDeleteSeam) {
    super(`subject offers no ${seam}() seam`);
    this.name = 'ScanDeleteCaseSkipped';
    this.seam = seam;
  }
}

export function isScanDeleteCaseSkipped(
  err: unknown,
): err is ScanDeleteCaseSkipped {
  return (
    err instanceof ScanDeleteCaseSkipped ||
    (err instanceof Error && err.name === 'ScanDeleteCaseSkipped')
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A guard against a store that never ends a scan. */
const MAX_PAGES = 1000;

type Row = [id: string, metadata: Record<string, unknown>];

/** Distinct words per record keep every two texts far apart. */
function textFor(id: string): string {
  return `record ${id} ${id}alpha ${id}bravo`;
}

async function seed(store: IRag, rows: readonly Row[]): Promise<void> {
  const writer = store.writer?.();
  if (!writer) throw new Error('store under test exposes no writer()');
  for (const [id, metadata] of rows) {
    const res = await writer.upsertRaw(id, textFor(id), metadata);
    if (!res.ok) throw res.error;
  }
}

type ScanOpts = { filter?: RagScanFilter; pageSize?: number };

/**
 * Every page of a scan. `between` runs after each page that returned a
 * cursor, before the next page is read.
 */
async function scanPages(
  store: IRagScanner,
  opts: ScanOpts = {},
  between?: (pageIndex: number) => Promise<void>,
): Promise<RagScanRecord[][]> {
  const pages: RagScanRecord[][] = [];
  let cursor: string | undefined;
  do {
    const res = await store.scan({ ...opts, ...(cursor ? { cursor } : {}) });
    if (!res.ok) throw res.error;
    const { records } = res.value;
    if (opts.pageSize !== undefined) {
      assert.ok(
        records.length <= opts.pageSize,
        `a page holds ${records.length} records, more than pageSize ${opts.pageSize}`,
      );
    }
    pages.push(records);
    cursor = res.value.cursor;
    if (cursor !== undefined && between) await between(pages.length - 1);
    assert.ok(pages.length <= MAX_PAGES, 'scan never ended');
  } while (cursor !== undefined);
  return pages;
}

async function scanIds(store: IRagScanner, opts?: ScanOpts): Promise<string[]> {
  const pages = await scanPages(store, opts);
  return pages.flat().map((r) => r.id);
}

function sorted(ids: readonly string[]): string[] {
  return [...ids].sort();
}

function countOf(ids: readonly string[], id: string): number {
  return ids.filter((x) => x === id).length;
}

async function catalogRecord(
  provider: IRagProvider,
  storeName: string,
): Promise<RagCollectionRecord | undefined> {
  if (!provider.describeCollections)
    throw new Error('catalog provider under test has no describeCollections()');
  const res = await provider.describeCollections();
  if (!res.ok) throw res.error;
  return res.value.records.find((r) => r.storeName === storeName);
}

async function requireCatalog(
  makeSubject: () => Promise<ScanDeleteSubject>,
): Promise<{
  provider: IRagProvider & IRagCatalogUpdater;
  create(name: string): Promise<void>;
}> {
  const s = await makeSubject();
  if (!s.catalog) throw new ScanDeleteCaseSkipped('catalog');
  return s.catalog();
}

/** Seed for the filter cases: owners, decoys and type-confused values. */
const FILTER_ROWS: readonly Row[] = [
  ['a', { userId: 'u1', sessionId: 's1', namespace: 'n1' }],
  ['b', { userId: 'u1', sessionId: 's2', namespace: 'n1' }],
  ['c', { userId: 'u2', sessionId: 's1', namespace: 'n2' }],
  ['upper', { userId: 'U1', sessionId: 'S1', namespace: 'N1' }],
  ['padded', { userId: 'u1 ', sessionId: 's1 ', namespace: 'n1 ' }],
  ['prefix', { userId: 'u10', sessionId: 's10', namespace: 'n10' }],
  ['num', { userId: 1, sessionId: 1, namespace: 1 }],
  ['str', { userId: '1', sessionId: '1', namespace: '1' }],
  ['bool', { userId: true, sessionId: true, namespace: true }],
  ['none', {}],
];

const ALL_FILTER_IDS = FILTER_ROWS.map(([id]) => id);

const PAST = () => Math.floor(Date.now() / 1000) - 3600;
const FUTURE = () => Math.floor(Date.now() / 1000) + 3600;

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

export const scanDeleteConformanceCases: readonly ScanDeleteConformanceCase[] =
  [
    {
      name: 'scan pages cover every record exactly once',
      async run(makeSubject) {
        const s = await makeSubject();
        const store = await s.store();
        // An empty collection scans to an end.
        assert.deepEqual(await scanIds(store, { pageSize: 3 }), []);

        const rows: Row[] = Array.from({ length: 11 }, (_, i) => [
          `p${String(i).padStart(2, '0')}`,
          { userId: `owner${i % 2}` },
        ]);
        await seed(store, rows);
        const want = sorted(rows.map(([id]) => id));

        for (const pageSize of [1, 3, 11, 50]) {
          const pages = await scanPages(store, { pageSize });
          const records = pages.flat();
          const ids = records.map((r) => r.id);
          assert.deepEqual(sorted(ids), want, `pageSize ${pageSize}`);
          assert.equal(new Set(ids).size, ids.length, `pageSize ${pageSize}`);
          for (const r of records) {
            assert.equal(r.text, textFor(r.id));
            assert.ok(!('vector' in r), 'a scan record carries no vector');
            assert.ok(!('embedding' in r), 'a scan record carries no vector');
          }
        }
        // The default page size covers them too.
        assert.deepEqual(sorted(await scanIds(store)), want);
        // The metadata comes back as written.
        const byId = new Map(
          (await scanPages(store)).flat().map((r) => [r.id, r] as const),
        );
        assert.equal(byId.get('p03')?.metadata.userId, 'owner1');
        assert.equal(byId.get('p04')?.metadata.userId, 'owner0');
      },
    },
    {
      name: 'scan applies the filter with strict string equality',
      async run(makeSubject) {
        const s = await makeSubject();
        const store = await s.store();
        await seed(store, FILTER_ROWS);
        const ids = async (filter: RagScanFilter): Promise<string[]> =>
          sorted(await scanIds(store, { filter, pageSize: 2 }));

        assert.deepEqual(await ids({}), sorted(ALL_FILTER_IDS));
        assert.deepEqual(await ids({ userId: 'u1' }), ['a', 'b']);
        assert.deepEqual(await ids({ sessionId: 's1' }), ['a', 'c']);
        assert.deepEqual(await ids({ namespace: 'n1' }), ['a', 'b']);
        assert.deepEqual(await ids({ userId: 'u1', sessionId: 's1' }), ['a']);
        assert.deepEqual(
          await ids({ userId: 'u1', sessionId: 's1', namespace: 'n2' }),
          [],
        );
        // A JSON number or boolean never matches its string form.
        assert.deepEqual(await ids({ userId: '1' }), ['str']);
        assert.deepEqual(await ids({ sessionId: '1' }), ['str']);
        assert.deepEqual(await ids({ namespace: '1' }), ['str']);
        assert.deepEqual(await ids({ userId: 'true' }), []);
        // Case, padding and prefixes are not equality.
        assert.deepEqual(await ids({ userId: 'U1' }), ['upper']);
        assert.deepEqual(await ids({ userId: 'u1 ' }), ['padded']);
        assert.deepEqual(await ids({ userId: 'u' }), []);
        assert.deepEqual(await ids({ userId: 'nobody' }), []);
      },
    },
    {
      name: 'scan includes expired records',
      async run(makeSubject) {
        const s = await makeSubject();
        const store = await s.store();
        await seed(store, [
          ['expired', { userId: 'u1', ttl: PAST() }],
          ['live', { userId: 'u1', ttl: FUTURE() }],
          ['forever', { userId: 'u1' }],
          ['expired-other', { userId: 'u2', ttl: PAST() }],
        ]);
        assert.deepEqual(sorted(await scanIds(store, { pageSize: 1 })), [
          'expired',
          'expired-other',
          'forever',
          'live',
        ]);
        assert.deepEqual(
          sorted(await scanIds(store, { filter: { userId: 'u1' } })),
          ['expired', 'forever', 'live'],
        );
      },
    },
    {
      name: 'scan under a concurrent insert neither skips nor repeats',
      async run(makeSubject) {
        const s = await makeSubject();
        const store = await s.store();
        const rows: Row[] = Array.from({ length: 9 }, (_, i) => [
          `c${i}`,
          { userId: 'u1' },
        ]);
        await seed(store, rows);
        const inserted: string[] = [];
        // Insert one record between every two pages: ids that sort before,
        // between and after the existing ones.
        const newIds = ['a-new', 'c4-new', 'z-new', 'b-new', 'c8-new', 'y-new'];
        const pages = await scanPages(store, { pageSize: 2 }, async (i) => {
          const id = `${newIds[i % newIds.length]}-${i}`;
          inserted.push(id);
          await seed(store, [[id, { userId: 'u1' }]]);
        });
        assert.ok(inserted.length > 0, 'the scan had more than one page');
        const ids = pages.flat().map((r) => r.id);
        for (const [id] of rows) {
          assert.equal(countOf(ids, id), 1, `pre-existing ${id} seen once`);
        }
        for (const id of inserted) {
          assert.ok(countOf(ids, id) <= 1, `inserted ${id} seen at most once`);
        }
        assert.equal(new Set(ids).size, ids.length, 'no record repeats');
        // Afterwards a fresh scan sees all of them.
        assert.deepEqual(
          sorted(await scanIds(store)),
          sorted([...rows.map(([id]) => id), ...inserted]),
        );
      },
    },
    {
      name: 'deleteWhere removes exactly the matches and counts them',
      async run(makeSubject) {
        const s = await makeSubject();
        const store = await s.store();
        await seed(store, [
          ...FILTER_ROWS,
          ['a-expired', { userId: 'u1', sessionId: 's1', ttl: PAST() }],
        ]);
        const all = sorted([...ALL_FILTER_IDS, 'a-expired']);

        const none = await store.deleteWhere({ userId: 'nobody' });
        if (!none.ok) throw none.error;
        assert.equal(none.value.deleted, 0);
        assert.deepEqual(sorted(await scanIds(store)), all);

        // Strict: '1' takes only the string row, never the number or boolean.
        const one = await store.deleteWhere({ userId: '1' });
        if (!one.ok) throw one.error;
        assert.equal(one.value.deleted, 1);

        // Both fields must match; the expired match goes too.
        const both = await store.deleteWhere({ userId: 'u1', sessionId: 's1' });
        if (!both.ok) throw both.error;
        assert.equal(both.value.deleted, 2);
        assert.deepEqual(
          sorted(await scanIds(store)),
          sorted(ALL_FILTER_IDS.filter((id) => id !== 'a' && id !== 'str')),
        );

        const u1 = await store.deleteWhere({ userId: 'u1' });
        if (!u1.ok) throw u1.error;
        assert.equal(u1.value.deleted, 1);
        const again = await store.deleteWhere({ userId: 'u1' });
        if (!again.ok) throw again.error;
        assert.equal(again.value.deleted, 0);

        const ns = await store.deleteWhere({ namespace: 'n2' });
        if (!ns.ok) throw ns.error;
        assert.equal(ns.value.deleted, 1);
        assert.deepEqual(sorted(await scanIds(store)), [
          'bool',
          'none',
          'num',
          'padded',
          'prefix',
          'upper',
        ]);
      },
    },
    {
      name: 'deleteWhere refuses an empty filter',
      async run(makeSubject) {
        const s = await makeSubject();
        const store = await s.store();
        await seed(store, FILTER_ROWS);
        for (const filter of [
          {},
          { userId: undefined, sessionId: undefined, namespace: undefined },
        ] as RagScanFilter[]) {
          const res = await store.deleteWhere(filter);
          assert.equal(res.ok, false, 'an empty filter is refused');
          if (!res.ok) assert.equal(res.error.code, INVALID_ARGUMENT);
        }
        assert.deepEqual(
          sorted(await scanIds(store)),
          sorted(ALL_FILTER_IDS),
          'a refused deleteWhere deletes nothing',
        );
      },
    },
    {
      name: 'deleteWhere stays inside its collection',
      requires: 'sibling',
      async run(makeSubject) {
        const s = await makeSubject();
        if (!s.sibling) throw new ScanDeleteCaseSkipped('sibling');
        const store = await s.store();
        const sibling = await s.sibling();
        const rows: Row[] = [
          ['shared-id', { userId: 'u1', sessionId: 's1' }],
          ['mine', { userId: 'u1', sessionId: 's1' }],
          ['kept', { userId: 'u2' }],
        ];
        await seed(store, rows);
        // The sibling holds rows that match the same filter, one of them
        // under the same id.
        await seed(sibling, [
          ['shared-id', { userId: 'u1', sessionId: 's1' }],
          ['theirs', { userId: 'u1', sessionId: 's1' }],
        ]);
        const res = await store.deleteWhere({ userId: 'u1' });
        if (!res.ok) throw res.error;
        assert.equal(res.value.deleted, 2, 'only its own matches are counted');
        assert.deepEqual(await scanIds(store), ['kept']);
        assert.deepEqual(sorted(await scanIds(sibling)), [
          'shared-id',
          'theirs',
        ]);
        // And scan never reaches the sibling either.
        assert.deepEqual(
          await scanIds(store, { filter: { userId: 'u1' } }),
          [],
        );
      },
    },
    {
      name: 'scan ids round-trip through getById and deleteById',
      async run(makeSubject) {
        const s = await makeSubject();
        const store = await s.store();
        const rows: Row[] = [
          ['plain', {}],
          ['with-dash-and.dot', { userId: 'u1' }],
          ['550e8400-e29b-41d4-a716-446655440000', { sessionId: 's1' }],
          ['expired', { ttl: PAST() }],
        ];
        await seed(store, rows);
        const ids = await scanIds(store, { pageSize: 2 });
        assert.deepEqual(sorted(ids), sorted(rows.map(([id]) => id)));
        const writer = store.writer?.();
        if (!writer) throw new Error('store under test exposes no writer()');
        for (const id of ids) {
          const got = await store.getById(id);
          if (!got.ok) throw got.error;
          assert.ok(got.value, `getById(${id}) finds the scanned record`);
          assert.equal(got.value.text, textFor(id));
          const del = await writer.deleteByIdRaw(id);
          if (!del.ok) throw del.error;
          assert.equal(del.value, true, `deleteByIdRaw(${id}) deletes it`);
          const gone = await store.getById(id);
          if (!gone.ok) throw gone.error;
          assert.equal(gone.value, null);
        }
        assert.deepEqual(await scanIds(store), []);
      },
    },
    {
      name: 'updateCollection replaces attributes and keeps the owner',
      requires: 'catalog',
      async run(makeSubject) {
        const { provider, create } = await requireCatalog(makeSubject);
        await create('scan-conf-upd');
        await create('scan-conf-other');
        const before = await catalogRecord(provider, 'scan-conf-upd');
        assert.ok(before, 'create() wrote a catalog record');
        const otherBefore = await catalogRecord(provider, 'scan-conf-other');

        const first = await provider.updateCollection('scan-conf-upd', {
          attributes: { roles: ['reader'], tier: 1 },
        });
        if (!first.ok) throw first.error;
        assert.deepEqual(
          (await catalogRecord(provider, 'scan-conf-upd'))?.attributes,
          { roles: ['reader'], tier: 1 },
        );

        // A second write replaces the attributes as a whole: no merge.
        const second = await provider.updateCollection('scan-conf-upd', {
          attributes: { owner: 'hub' },
        });
        if (!second.ok) throw second.error;
        const after = await catalogRecord(provider, 'scan-conf-upd');
        assert.ok(after);
        assert.deepEqual(after, { ...before, attributes: { owner: 'hub' } });

        // collectionName changes the display name only.
        const renamed = await provider.updateCollection('scan-conf-upd', {
          collectionName: 'Renamed display',
        });
        if (!renamed.ok) throw renamed.error;
        assert.deepEqual(await catalogRecord(provider, 'scan-conf-upd'), {
          ...before,
          name: 'Renamed display',
          attributes: { owner: 'hub' },
        });
        // Another record is untouched.
        assert.deepEqual(
          await catalogRecord(provider, 'scan-conf-other'),
          otherBefore,
        );
      },
    },
    {
      name: 'updateCollection on a missing record is RAG_COLLECTION_NOT_FOUND',
      requires: 'catalog',
      async run(makeSubject) {
        const { provider, create } = await requireCatalog(makeSubject);
        await create('scan-conf-present');
        const res = await provider.updateCollection('scan-conf-absent', {
          attributes: { a: 1 },
        });
        assert.equal(res.ok, false, 'a missing record is an error');
        if (!res.ok) assert.equal(res.error.code, RAG_COLLECTION_NOT_FOUND);
        // The update created nothing.
        assert.equal(
          await catalogRecord(provider, 'scan-conf-absent'),
          undefined,
        );
      },
    },
    {
      name: 'updateCollection refuses an empty patch',
      requires: 'catalog',
      async run(makeSubject) {
        const { provider, create } = await requireCatalog(makeSubject);
        await create('scan-conf-empty');
        const before = await catalogRecord(provider, 'scan-conf-empty');
        assert.ok(before, 'create() wrote a catalog record');
        const res = await provider.updateCollection('scan-conf-empty', {});
        assert.equal(res.ok, false, 'an empty patch is refused');
        if (!res.ok) assert.equal(res.error.code, INVALID_ARGUMENT);
        assert.deepEqual(
          await catalogRecord(provider, 'scan-conf-empty'),
          before,
        );
      },
    },
  ];
