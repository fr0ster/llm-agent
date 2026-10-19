/**
 * Conformance kit for a store with a `shared` table layout: one documents
 * table holds every collection's rows, told apart by a collection column, and
 * the provider keeps one catalog record per collection beside it.
 *
 * The contract:
 *
 * - a collection sees only its own rows — by id, by query, and when cleared;
 *   the same id in two collections names two records;
 * - the identity, namespace and ttl filters hold within a collection, as the
 *   `rag-filter-conformance` kit states them;
 * - rows of a collection without a record are an orphan: `createCollection`
 *   refuses it with `OrphanStoreError` unless `adoptExisting`, which keeps the
 *   rows; a second create is a `DuplicateCollectionError`;
 * - `deleteCollection` removes the collection's rows and its record;
 * - `listCollections` is the sorted, de-duplicated union of the recorded
 *   collections and the collections holding rows.
 *
 * Framework-agnostic: each case throws (`node:assert`) on a violation, so a
 * store package runs them under its own test runner:
 *
 * ```ts
 * for (const c of sharedTableConformanceCases) {
 *   it(c.name, () => c.run(async () => mySubject()));
 * }
 * ```
 *
 * Every case asks the factory for a FRESH subject over empty tables. The
 * stores and the provider must embed with {@link conformanceEmbedder}.
 */

import assert from 'node:assert/strict';
import type { IRag, IRagProvider } from '../interfaces/rag.js';
import {
  DuplicateCollectionError,
  OrphanStoreError,
} from '../rag/corrections/errors.js';
import {
  conformanceEmbedder,
  ragFilterConformanceCases,
} from './rag-filter-conformance.js';

/** One backend in the `shared` layout: stores and a provider over the same tables. */
export interface SharedTableSubject {
  /** A direct store, shared layout, over the one backing documents table. */
  openStore(collection: string): Promise<IRag>;
  /** A provider over the same backing tables. */
  provider(): Promise<IRagProvider>;
  /** Orphan setup: a document row for `collection`, bypassing the provider. */
  rawInsert(collection: string, id: string, text: string): Promise<void>;
}

export interface SharedTableConformanceCase {
  readonly name: string;
  run(makeSubject: () => Promise<SharedTableSubject>): Promise<void>;
}

async function put(rag: IRag, id: string, text: string): Promise<void> {
  const writer = rag.writer?.();
  if (!writer) throw new Error('store under test exposes no writer()');
  const res = await writer.upsertRaw(id, text, {});
  if (!res.ok) throw res.error;
}

async function textOf(rag: IRag, id: string): Promise<string | null> {
  const res = await rag.getById(id);
  if (!res.ok) throw res.error;
  return res.value ? res.value.text : null;
}

/** Ids of the top-`k` records for `text`, in the order the store returned them. */
async function rankedIds(rag: IRag, text: string, k = 10): Promise<string[]> {
  const embedder = conformanceEmbedder();
  const res = await rag.query(
    { text, toVector: async () => (await embedder.embed(text)).vector },
    k,
  );
  if (!res.ok) throw res.error;
  return res.value.map((r) => String(r.metadata.id));
}

async function list(provider: IRagProvider): Promise<string[]> {
  if (!provider.listCollections)
    throw new Error('provider under test has no listCollections()');
  const res = await provider.listCollections();
  if (!res.ok) throw res.error;
  return res.value;
}

async function create(
  provider: IRagProvider,
  name: string,
  adoptExisting?: boolean,
): Promise<IRag> {
  const res = await provider.createCollection(name, {
    scope: 'global',
    ...(adoptExisting ? { adoptExisting } : {}),
  });
  if (!res.ok) throw res.error;
  return res.value.rag;
}

const Q = 'quarterly revenue forecast';

export const sharedTableConformanceCases: readonly SharedTableConformanceCase[] =
  [
    {
      name: 'same id in two collections is independent',
      async run(makeSubject) {
        const s = await makeSubject();
        const a = await s.openStore('alpha');
        const b = await s.openStore('beta');
        await put(a, 'x', 'alpha harbour lighthouse');
        await put(b, 'x', 'bravo mountain glacier');
        assert.equal(await textOf(a, 'x'), 'alpha harbour lighthouse');
        assert.equal(await textOf(b, 'x'), 'bravo mountain glacier');
        // An upsert in one collection does not overwrite the other's record.
        await put(a, 'x', 'charlie desert oasis');
        assert.equal(await textOf(b, 'x'), 'bravo mountain glacier');
        const writer = a.writer?.();
        if (!writer) throw new Error('store under test exposes no writer()');
        const deleted = await writer.deleteByIdRaw('x');
        if (!deleted.ok) throw deleted.error;
        assert.equal(deleted.value, true);
        assert.equal(await textOf(a, 'x'), null);
        assert.equal(await textOf(b, 'x'), 'bravo mountain glacier');
      },
    },
    {
      name: 'clearAll empties only its collection',
      async run(makeSubject) {
        const s = await makeSubject();
        const a = await s.openStore('alpha');
        const b = await s.openStore('beta');
        await put(a, 'a-1', 'delta forest canopy');
        await put(a, 'a-2', 'echo river delta');
        await put(b, 'b-1', 'foxtrot volcano crater');
        const writer = a.writer?.();
        if (!writer?.clearAll)
          throw new Error('store under test has no clearAll()');
        const cleared = await writer.clearAll();
        if (!cleared.ok) throw cleared.error;
        assert.deepEqual(await rankedIds(a, Q), []);
        assert.equal(await textOf(a, 'a-1'), null);
        assert.deepEqual(await rankedIds(b, Q), ['b-1']);
        assert.equal(await textOf(b, 'b-1'), 'foxtrot volcano crater');
      },
    },
    {
      name: "query returns only its collection's rows, best first",
      async run(makeSubject) {
        const s = await makeSubject();
        const a = await s.openStore('alpha');
        const b = await s.openStore('beta');
        await put(a, 'a-far', 'golf tundra permafrost');
        await put(a, 'a-near', 'quarterly revenue forecast europe');
        await put(a, 'a-mid', 'quarterly budget europe asia');
        // The best match of all, but in the other collection.
        await put(b, 'b-best', 'quarterly revenue forecast');
        assert.deepEqual(await rankedIds(a, Q), ['a-near', 'a-mid', 'a-far']);
        assert.deepEqual(await rankedIds(a, Q, 1), ['a-near']);
        assert.deepEqual(await rankedIds(b, Q), ['b-best']);
      },
    },
    {
      name: 'identity, namespace and ttl filters hold within a collection',
      async run(makeSubject) {
        for (const c of ragFilterConformanceCases) {
          try {
            await c.run(async () => {
              const s = await makeSubject();
              // A neighbour whose row matches every filter the cases use: it
              // must never surface in 'docs'.
              const neighbour = await s.openStore('neighbour');
              await put(
                neighbour,
                'neighbour-row',
                'quarterly revenue forecast',
              );
              const writer = neighbour.writer?.();
              if (!writer) throw new Error('store exposes no writer()');
              const res = await writer.upsertRaw(
                'neighbour-owned',
                'quarterly revenue forecast owned',
                { sessionId: 's1', userId: 'u1', namespace: 'a' },
              );
              if (!res.ok) throw res.error;
              return s.openStore('docs');
            });
          } catch (err) {
            throw new Error(`${c.name}: ${String(err)}`, { cause: err });
          }
        }
      },
    },
    {
      name: 'orphan rows: refused without adoptExisting, adopted with it, listed either way',
      async run(makeSubject) {
        const s = await makeSubject();
        await s.rawInsert('orphan', 'o-1', 'hotel savanna acacia');
        const provider = await s.provider();
        assert.deepEqual(await list(provider), ['orphan']);
        const refused = await provider.createCollection('orphan', {
          scope: 'global',
        });
        assert.equal(refused.ok, false);
        if (!refused.ok) assert.ok(refused.error instanceof OrphanStoreError);
        // The refusal leaves the rows where they are.
        assert.equal(
          await textOf(await s.openStore('orphan'), 'o-1'),
          'hotel savanna acacia',
        );
        const adopted = await create(provider, 'orphan', true);
        assert.equal(await textOf(adopted, 'o-1'), 'hotel savanna acacia');
        assert.deepEqual(await list(provider), ['orphan']);
        const again = await provider.createCollection('orphan', {
          scope: 'global',
          adoptExisting: true,
        });
        assert.equal(again.ok, false);
        if (!again.ok)
          assert.ok(again.error instanceof DuplicateCollectionError);
      },
    },
    {
      name: 'delete removes rows then record',
      async run(makeSubject) {
        const s = await makeSubject();
        const provider = await s.provider();
        const gone = await create(provider, 'gone');
        await put(gone, 'g-1', 'india reef coral');
        const kept = await create(provider, 'kept');
        await put(kept, 'k-1', 'juliet canyon mesa');
        if (!provider.deleteCollection)
          throw new Error('provider under test has no deleteCollection()');
        const deleted = await provider.deleteCollection('gone');
        if (!deleted.ok) throw deleted.error;
        assert.deepEqual(await list(provider), ['kept']);
        if (provider.describeCollections) {
          const described = await provider.describeCollections();
          if (!described.ok) throw described.error;
          assert.deepEqual(
            described.value.records.map((r) => r.storeName),
            ['kept'],
          );
        }
        assert.equal(await textOf(await s.openStore('gone'), 'g-1'), null);
        assert.equal(
          await textOf(await s.openStore('kept'), 'k-1'),
          'juliet canyon mesa',
        );
        // No orphan rows are left behind: the name is free again.
        const recreated = await create(provider, 'gone');
        assert.deepEqual(await rankedIds(recreated, Q), []);
      },
    },
    {
      name: 'list is the union of records and row collections',
      async run(makeSubject) {
        const s = await makeSubject();
        const provider = await s.provider();
        await create(provider, 'recorded');
        const both = await create(provider, 'both');
        await put(both, 'b-1', 'kilo prairie bison');
        await put(both, 'b-2', 'lima penguin iceberg');
        await s.rawInsert('unrecorded', 'u-1', 'mike tundra reindeer');
        await put(await s.openStore('direct'), 'd-1', 'november jungle parrot');
        assert.deepEqual(await list(provider), [
          'both',
          'direct',
          'recorded',
          'unrecorded',
        ]);
      },
    },
  ];
