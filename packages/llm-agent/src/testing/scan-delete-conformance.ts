/**
 * Conformance kit for `IRagScanner.scan`, `IRagFilteredDeleter.deleteWhere`
 * and `IRagCatalogUpdater.updateCollection`.
 *
 * The contract:
 *
 * - `scan` pages cover every record of the collection exactly once, expired
 *   records included; a page holds at most `pageSize` records and may be
 *   short or empty; only a missing `cursor` ends a scan; no vectors;
 * - `scan` refuses a `pageSize` that is not a positive integer and a cursor it
 *   did not issue with `INVALID_ARGUMENT`; `scan` and `deleteWhere` refuse a
 *   filter value that is not a string with `INVALID_ARGUMENT`, and return
 *   `ABORTED` for an aborted signal, all before touching a record;
 * - an insert between two pages never makes the scan skip or repeat a record
 *   that existed when the scan started;
 * - the `userId` / `sessionId` / `namespace` filter is strict string equality:
 *   `123` (a number) never matches `'123'`, `'U1'` never matches `'u1'`, an
 *   array holding `'u1'` never matches `'u1'`;
 * - `deleteWhere` deletes exactly the matching records (expired included),
 *   returns how many, refuses an empty filter with `INVALID_ARGUMENT`, and
 *   never reaches another collection of the same backend storage;
 * - a scanned id round-trips through `getById` and `deleteByIdRaw`;
 * - `updateCollection` replaces `attributes` as a whole and keeps `storeName`,
 *   `scope` and the owner; a missing record is `RAG_COLLECTION_NOT_FOUND`; an
 *   empty patch and a `collectionName` that is not a non-empty string are
 *   `INVALID_ARGUMENT`.
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
  type RagCatalogPatch,
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
   *
   * `create(name)` always receives a FRESH name, unique per case run
   * (`scan_conf_<case>_<runId>`, a valid SQL identifier), so a runner needs no
   * catalog cleanup between runs; it should still remove what it created when
   * that is cheap.
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

/**
 * A catalog store name unique to one case run: `scan_conf_<tag>_<runId>`,
 * matching `^[a-zA-Z_][a-zA-Z0-9_]{0,62}$`.
 */
function freshCatalogNames<T extends string>(...tags: T[]): Record<T, string> {
  const runId = `${Date.now().toString(36)}${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const names = {} as Record<T, string>;
  for (const tag of tags) names[tag] = `scan_conf_${tag}_${runId}`;
  return names;
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
      name: 'an array identity value is not matched',
      async run(makeSubject) {
        const s = await makeSubject();
        const store = await s.store();
        await seed(store, [
          ['multi', { userId: ['u1', 'u2'], sessionId: ['s1'] }],
          ['single', { userId: 'u1', sessionId: 's1' }],
        ]);
        // An array holding the value is not equal to it (Qdrant's own
        // `match.value` would match an element).
        assert.deepEqual(
          await scanIds(store, { filter: { userId: 'u1' }, pageSize: 1 }),
          ['single'],
        );
        assert.deepEqual(
          await scanIds(store, { filter: { sessionId: 's1' }, pageSize: 1 }),
          ['single'],
        );
        const res = await store.deleteWhere({ userId: 'u1' });
        if (!res.ok) throw res.error;
        assert.equal(res.value.deleted, 1, 'only the string match is deleted');
        assert.deepEqual(await scanIds(store), ['multi']);
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
      name: 'scan refuses a non-positive-integer pageSize',
      async run(makeSubject) {
        const s = await makeSubject();
        const store = await s.store();
        await seed(store, [['only', { userId: 'u1' }]]);
        for (const pageSize of [0, -1, 1.5, Number.NaN, Infinity]) {
          const res = await store.scan({ pageSize });
          assert.equal(res.ok, false, `pageSize ${pageSize} is refused`);
          if (!res.ok)
            assert.equal(
              res.error.code,
              INVALID_ARGUMENT,
              `pageSize ${pageSize}`,
            );
        }
        // A positive integer still works.
        assert.deepEqual(await scanIds(store, { pageSize: 1 }), ['only']);
      },
    },
    {
      name: 'scan refuses a malformed cursor',
      async run(makeSubject) {
        const s = await makeSubject();
        const store = await s.store();
        await seed(store, [
          ['m1', { userId: 'u1' }],
          ['m2', { userId: 'u1' }],
        ]);
        for (const cursor of ['not a cursor!', '', '{"x":1}']) {
          const res = await store.scan({ pageSize: 1, cursor });
          assert.equal(
            res.ok,
            false,
            `cursor ${JSON.stringify(cursor)} is refused`,
          );
          if (!res.ok)
            assert.equal(
              res.error.code,
              INVALID_ARGUMENT,
              `cursor ${JSON.stringify(cursor)}`,
            );
        }
        // The cursors the store issues still page through everything.
        assert.deepEqual(sorted(await scanIds(store, { pageSize: 1 })), [
          'm1',
          'm2',
        ]);
      },
    },
    {
      name: 'scan and deleteWhere refuse a non-string filter value',
      async run(makeSubject) {
        const s = await makeSubject();
        const store = await s.store();
        await seed(store, FILTER_ROWS);
        const bad = [
          { userId: 1 },
          { sessionId: true },
          { namespace: null },
          { userId: ['u1'] },
          { userId: 'u1', sessionId: 1 },
        ] as unknown as RagScanFilter[];
        for (const filter of bad) {
          const label = JSON.stringify(filter);
          const scanned = await store.scan({ filter });
          assert.equal(scanned.ok, false, `scan refuses ${label}`);
          if (!scanned.ok)
            assert.equal(scanned.error.code, INVALID_ARGUMENT, label);
          const deleted = await store.deleteWhere(filter);
          assert.equal(deleted.ok, false, `deleteWhere refuses ${label}`);
          if (!deleted.ok)
            assert.equal(deleted.error.code, INVALID_ARGUMENT, label);
        }
        assert.deepEqual(
          sorted(await scanIds(store)),
          sorted(ALL_FILTER_IDS),
          'a refused deleteWhere deletes nothing',
        );
      },
    },
    {
      name: 'scan and deleteWhere return ABORTED for an aborted signal',
      async run(makeSubject) {
        const s = await makeSubject();
        const store = await s.store();
        await seed(store, [
          ['x1', { userId: 'u1' }],
          ['x2', { userId: 'u1' }],
        ]);
        const ctrl = new AbortController();
        ctrl.abort();
        const scanned = await store.scan(
          { pageSize: 1 },
          { signal: ctrl.signal },
        );
        assert.equal(scanned.ok, false, 'an aborted scan fails');
        if (!scanned.ok) assert.equal(scanned.error.code, 'ABORTED');
        // The abort is checked first: an invalid pageSize or an empty filter
        // still reports ABORTED.
        const scanBad = await store.scan(
          { pageSize: 0 },
          { signal: ctrl.signal },
        );
        assert.equal(scanBad.ok, false);
        if (!scanBad.ok) assert.equal(scanBad.error.code, 'ABORTED');
        const deleted = await store.deleteWhere(
          { userId: 'u1' },
          { signal: ctrl.signal },
        );
        assert.equal(deleted.ok, false, 'an aborted deleteWhere fails');
        if (!deleted.ok) assert.equal(deleted.error.code, 'ABORTED');
        const deleteEmpty = await store.deleteWhere(
          {},
          { signal: ctrl.signal },
        );
        assert.equal(deleteEmpty.ok, false);
        if (!deleteEmpty.ok) assert.equal(deleteEmpty.error.code, 'ABORTED');
        assert.deepEqual(
          sorted(await scanIds(store)),
          ['x1', 'x2'],
          'an aborted deleteWhere deletes nothing',
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
        const n = freshCatalogNames('upd', 'other');
        await create(n.upd);
        await create(n.other);
        const before = await catalogRecord(provider, n.upd);
        assert.ok(before, 'create() wrote a catalog record');
        const otherBefore = await catalogRecord(provider, n.other);

        const first = await provider.updateCollection(n.upd, {
          attributes: { roles: ['reader'], tier: 1 },
        });
        if (!first.ok) throw first.error;
        assert.deepEqual((await catalogRecord(provider, n.upd))?.attributes, {
          roles: ['reader'],
          tier: 1,
        });

        // A second write replaces the attributes as a whole: no merge.
        const second = await provider.updateCollection(n.upd, {
          attributes: { owner: 'hub' },
        });
        if (!second.ok) throw second.error;
        const after = await catalogRecord(provider, n.upd);
        assert.ok(after);
        assert.deepEqual(after, { ...before, attributes: { owner: 'hub' } });

        // collectionName changes the display name only.
        const renamed = await provider.updateCollection(n.upd, {
          collectionName: 'Renamed display',
        });
        if (!renamed.ok) throw renamed.error;
        assert.deepEqual(await catalogRecord(provider, n.upd), {
          ...before,
          name: 'Renamed display',
          attributes: { owner: 'hub' },
        });
        // Another record is untouched.
        assert.deepEqual(await catalogRecord(provider, n.other), otherBefore);
      },
    },
    {
      name: 'updateCollection on a missing record is RAG_COLLECTION_NOT_FOUND',
      requires: 'catalog',
      async run(makeSubject) {
        const { provider, create } = await requireCatalog(makeSubject);
        const n = freshCatalogNames('present', 'absent');
        await create(n.present);
        const res = await provider.updateCollection(n.absent, {
          attributes: { a: 1 },
        });
        assert.equal(res.ok, false, 'a missing record is an error');
        if (!res.ok) assert.equal(res.error.code, RAG_COLLECTION_NOT_FOUND);
        // The update created nothing.
        assert.equal(await catalogRecord(provider, n.absent), undefined);
      },
    },
    {
      name: 'updateCollection refuses an empty patch',
      requires: 'catalog',
      async run(makeSubject) {
        const { provider, create } = await requireCatalog(makeSubject);
        const n = freshCatalogNames('empty');
        await create(n.empty);
        const before = await catalogRecord(provider, n.empty);
        assert.ok(before, 'create() wrote a catalog record');
        // Both forms are empty: no key, and keys that are all undefined.
        for (const patch of [
          {},
          { collectionName: undefined, attributes: undefined },
        ] as RagCatalogPatch[]) {
          const res = await provider.updateCollection(n.empty, patch);
          assert.equal(
            res.ok,
            false,
            `an empty patch is refused: ${JSON.stringify(Object.keys(patch))}`,
          );
          if (!res.ok) assert.equal(res.error.code, INVALID_ARGUMENT);
        }
        assert.deepEqual(await catalogRecord(provider, n.empty), before);
      },
    },
    {
      name: 'updateCollection refuses an invalid collectionName',
      requires: 'catalog',
      async run(makeSubject) {
        const { provider, create } = await requireCatalog(makeSubject);
        const n = freshCatalogNames('badname');
        await create(n.badname);
        const before = await catalogRecord(provider, n.badname);
        assert.ok(before, 'create() wrote a catalog record');
        for (const collectionName of ['', '   ', 42, null]) {
          const label = `collectionName ${JSON.stringify(collectionName)}`;
          const patch = { collectionName } as unknown as RagCatalogPatch;
          const res = await provider.updateCollection(n.badname, patch);
          assert.equal(res.ok, false, `${label} is refused`);
          if (!res.ok) assert.equal(res.error.code, INVALID_ARGUMENT, label);
          // Refused as a whole: valid attributes beside it are not written.
          const withAttrs = await provider.updateCollection(n.badname, {
            ...patch,
            attributes: { changed: true },
          });
          assert.equal(withAttrs.ok, false, `${label} with attributes`);
          if (!withAttrs.ok)
            assert.equal(withAttrs.error.code, INVALID_ARGUMENT, label);
        }
        assert.deepEqual(await catalogRecord(provider, n.badname), before);
      },
    },
  ];
