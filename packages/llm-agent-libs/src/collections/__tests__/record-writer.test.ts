// packages/llm-agent-libs/src/collections/__tests__/record-writer.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type CallOptions,
  type IEmbedder,
  type IRag,
  RagError,
  type RagMetadata,
  type RecordDraft,
  type RecordOwner,
  recordId,
  symmetricEmbedder,
} from '@mcp-abap-adt/llm-agent';
import { InMemoryRag, VectorRag } from '@mcp-abap-adt/llm-agent-rag';
import {
  duplicateItemsError,
  getItem,
  prepareItem,
  removeItem,
  storeItems,
} from '../record-writer.js';

const U_A: RecordOwner = { scope: 'user', userId: 'A' };
const draft = (
  kind: string,
  text: string,
  owner: RecordOwner = U_A,
): RecordDraft => ({
  text,
  itemId: 'case-42',
  recordKind: kind,
  owner,
  ...(kind === 'item'
    ? { metadata: { data: { n: 1 } } }
    : { itemText: 'canon' }),
});
const prep = (drafts: RecordDraft[], max = 5, ttl?: number) =>
  prepareItem(
    { itemId: 'case-42', drafts, ...(ttl !== undefined ? { ttl } : {}) },
    {
      canonicalKind: 'item',
      profile: 'shared-items',
      maxRecordsPerItem: max,
    },
  );

describe('prepareItem', () => {
  it('owner-scoped ids; positions per kind; framework metadata; recordIds on the canonical', () => {
    const p = prep(
      [draft('item', 'canon'), draft('note', 'n0'), draft('note', 'n1')],
      5,
      99,
    );
    assert.ok(p.ok);
    const { canonical, others } = p.item;
    assert.equal(canonical?.id, recordId(U_A, 'case-42', 'item', 0));
    assert.deepEqual(
      others.map((r) => r.id),
      [
        recordId(U_A, 'case-42', 'note', 0),
        recordId(U_A, 'case-42', 'note', 1),
      ],
    );
    // Every reserved key but `id` is written, absent ones as `undefined` (merging stores).
    assert.deepEqual(canonical?.metadata, {
      data: { n: 1 },
      itemId: 'case-42',
      recordKind: 'item',
      profile: 'shared-items',
      visibility: 'user',
      userId: 'A',
      groupId: undefined,
      sessionId: undefined,
      itemText: undefined,
      ttl: 99,
      recordIds: others.map((r) => r.id),
      staleRecordIds: undefined,
    });
    assert.equal(others[0].metadata.itemText, 'canon');
    assert.ok(
      'staleRecordIds' in others[0].metadata,
      'non-canonical records write every reserved key too',
    );
  });
  it('refusals: too many records, missing canonical, mixed owners', () => {
    assert.deepEqual(prep([draft('item', 'c'), draft('n', 'x')], 1), {
      ok: false,
      reason: 'too-many-records',
    });
    assert.deepEqual(prep([draft('note', 'x')]), {
      ok: false,
      reason: 'missing-canonical',
    });
    assert.deepEqual(
      prep([draft('item', 'c'), draft('n', 'x', { scope: 'global' })]),
      {
        ok: false,
        reason: 'owner-mismatch',
      },
    );
  });
});

describe('storeItems / getItem / removeItem', () => {
  it('re-indexing writes the new records and deletes the unlisted old ones', async () => {
    const rag = new InMemoryRag();
    const first = prep([
      draft('item', 'v1'),
      draft('note', 'old-a'),
      draft('note', 'old-b'),
    ]);
    assert.ok(first.ok);
    await storeItems(rag, [first.item]);
    const second = prep([draft('item', 'v2'), draft('note', 'new-a')]);
    assert.ok(second.ok);
    const r = await storeItems(rag, [second.item]);
    assert.deepEqual(r.indexed, [true]);
    const gone = await rag.getById(recordId(U_A, 'case-42', 'note', 1));
    assert.ok(gone.ok && gone.value === null);
    const canon = await rag.getById(recordId(U_A, 'case-42', 'item', 0));
    assert.ok(canon.ok && canon.value?.text === 'v2');
  });

  it('one batch embedding pass for every record when the store embedder batches', async () => {
    const calls: number[] = [];
    const embedder: IEmbedder & {
      embedBatch(t: string[]): Promise<{ vector: number[] }[]>;
    } = {
      embed: async () => ({ vector: [1, 0] }),
      embedBatch: async (texts: string[]) => {
        calls.push(texts.length);
        return texts.map(() => ({ vector: [1, 0] }));
      },
    };
    const rag = new VectorRag(symmetricEmbedder(embedder));
    const a = prep([draft('item', 'c'), draft('note', 'x')]);
    const b = prepareItem(
      {
        itemId: 'case-43',
        drafts: [{ ...draft('item', 'd'), itemId: 'case-43' }],
      },
      { canonicalKind: 'item', profile: 'p', maxRecordsPerItem: 5 },
    );
    assert.ok(a.ok && b.ok);
    const r = await storeItems(rag, [a.item, b.item]);
    assert.deepEqual(calls, [3]);
    assert.deepEqual(r.indexed, [true, true]);
    assert.equal(r.records, 3);
  });

  it('getItem: the canonical record as an item, identity-checked', async () => {
    const rag = new InMemoryRag();
    const p = prep([draft('item', 'canon')]);
    assert.ok(p.ok);
    await storeItems(rag, [p.item]);
    const id = recordId(U_A, 'case-42', 'item', 0);
    const mine = await getItem(rag, id, { ragFilter: { userId: 'A' } });
    assert.ok(mine.ok);
    assert.equal(mine.value?.text, 'canon');
    assert.equal(mine.value?.metadata.id, 'case-42');
    assert.deepEqual(mine.value?.metadata.data, { n: 1 });
    const foreign = await getItem(rag, id, { ragFilter: { userId: 'B' } });
    assert.ok(foreign.ok && foreign.value === null);
  });

  it('removeItem deletes what the canonical lists, then the canonical', async () => {
    const rag = new InMemoryRag();
    const p = prep([draft('item', 'c'), draft('note', 'x')]);
    assert.ok(p.ok);
    await storeItems(rag, [p.item]);
    const n = await removeItem(rag, recordId(U_A, 'case-42', 'item', 0));
    assert.ok(n.ok);
    assert.equal(n.value, 2);
    const none = await removeItem(rag, recordId(U_A, 'case-42', 'item', 0));
    assert.ok(none.ok && none.value === 0);
  });
});

/** The two stores that merge metadata on a write to an existing id (table above) — one list for every merging-store case in this file. */
const MERGING_STORES: [string, () => IRag][] = [
  ['InMemoryRag', () => new InMemoryRag()],
  [
    'VectorRag',
    () =>
      new VectorRag(
        symmetricEmbedder({ embed: async () => ({ vector: [1, 0] }) }),
      ),
  ],
];

describe('replacement replaces the record on a store that merges metadata (spec §3.3)', () => {
  for (const [name, make] of MERGING_STORES) {
    it(`${name}: keys the new item leaves out are gone after replacement`, async () => {
      const rag = make();
      const canonId = recordId(U_A, 'case-42', 'item', 0);
      const noteId = recordId(U_A, 'case-42', 'note', 0);
      const old = prepareItem(
        {
          itemId: 'case-42',
          // canonical: extra `data` + `itemText`; note: `itemText` (draft helper)
          drafts: [
            { ...draft('item', 'v1'), itemText: 'old text' },
            draft('note', 'n0'),
          ],
        },
        { canonicalKind: 'item', profile: 'p', maxRecordsPerItem: 5 },
      );
      const next = prepareItem(
        {
          itemId: 'case-42',
          drafts: [
            { text: 'v2', itemId: 'case-42', recordKind: 'item', owner: U_A },
            {
              text: 'n0-v2',
              itemId: 'case-42',
              recordKind: 'note',
              owner: U_A,
            },
          ],
        },
        { canonicalKind: 'item', profile: 'p', maxRecordsPerItem: 5 },
      );
      assert.ok(old.ok && next.ok);
      await storeItems(rag, [old.item]);
      const before = await rag.getById(canonId);
      assert.ok(before.ok && before.value);
      assert.deepEqual(before.value.metadata.data, { n: 1 });
      assert.equal(before.value.metadata.itemText, 'old text');

      const r = await storeItems(rag, [next.item]);
      assert.deepEqual(r.indexed, [true]);
      const after = await rag.getById(canonId);
      assert.ok(after.ok && after.value);
      assert.equal(after.value.text, 'v2');
      for (const k of ['data', 'itemText', 'staleRecordIds']) {
        assert.equal(after.value.metadata[k], undefined, k);
      }
      assert.equal(
        after.value.metadata.itemId,
        'case-42',
        'the framework keys are rewritten',
      );
      const note = await rag.getById(noteId);
      assert.ok(note.ok && note.value);
      assert.equal(note.value.text, 'n0-v2');
      assert.equal(
        note.value.metadata.itemText,
        undefined,
        'reserved keys are rewritten on every record',
      );
    });
  }
});

/** A store whose writer fails deleteByIdRaw for the ids in `failing` (F3 tests). */
function flakyDeletes(inner: InMemoryRag, failing: Set<string>): IRag {
  const w = inner.writer();
  return {
    ...inner,
    query: inner.query.bind(inner),
    getById: inner.getById.bind(inner),
    writer: () => ({
      ...w,
      deleteByIdRaw: async (id: string, o?: CallOptions) =>
        failing.has(id)
          ? { ok: false as const, error: new RagError('delete down') }
          : w.deleteByIdRaw(id, o),
    }),
  } as IRag;
}

/**
 * A store whose embedder batches and whose bulk write fails (`ok: false`, or a
 * throw) while every individual write would succeed. `calls` records each write path.
 */
function bulkWriteDown(mode: 'error' | 'throw'): {
  rag: IRag;
  inner: InMemoryRag;
  calls: string[];
} {
  const inner = new InMemoryRag();
  const w = inner.writer();
  const calls: string[] = [];
  const embedder = {
    embedDocument: async () => ({ vector: [1, 0] }),
    embedDocuments: async (ts: string[]) => ts.map(() => ({ vector: [1, 0] })),
    embedQuery: async () => ({ vector: [1, 0] }),
  };
  const rag = {
    ...inner,
    query: inner.query.bind(inner),
    getById: inner.getById.bind(inner),
    retrievalEmbedder: embedder, // IRetrievalEmbedderOwner: the batch embedding runs
    writer: () => ({
      ...w,
      upsertManyPrecomputedRaw: async () => {
        calls.push('bulk');
        if (mode === 'throw') throw new Error('bulk down');
        return { ok: false as const, error: new RagError('bulk down') };
      },
      upsertPrecomputedRaw: async (
        id: string,
        text: string,
        _v: number[],
        meta: RagMetadata,
        o?: CallOptions,
      ) => {
        calls.push('one');
        return w.upsertRaw(id, text, meta, o);
      },
      upsertRaw: async (
        id: string,
        text: string,
        meta: RagMetadata,
        o?: CallOptions,
      ) => {
        calls.push('one');
        return w.upsertRaw(id, text, meta, o);
      },
    }),
  } as unknown as IRag;
  return { rag, inner, calls };
}

describe('a failed bulk write fails its items — never retried record by record (spec §3.3, D76)', () => {
  for (const mode of ['error', 'throw'] as const) {
    it(`bulk write ${mode === 'error' ? 'answers ok: false' : 'throws'} → every item failed with the bulk error; no individual write`, async () => {
      const { rag, inner, calls } = bulkWriteDown(mode);
      const a = prep([draft('item', 'c'), draft('note', 'x')]);
      const b = prepareItem(
        {
          itemId: 'case-43',
          drafts: [{ ...draft('item', 'd'), itemId: 'case-43' }],
        },
        { canonicalKind: 'item', profile: 'p', maxRecordsPerItem: 5 },
      );
      assert.ok(a.ok && b.ok);
      const r = await storeItems(rag, [a.item, b.item]);
      assert.deepEqual(r.indexed, [false, false]);
      assert.equal(r.records, 0);
      for (const f of r.failures)
        assert.match(f ?? '', /^write-failed: bulk write failed: .*bulk down/);
      assert.ok(
        calls.length > 0 && calls.every((c) => c === 'bulk'),
        `only bulk writes, got ${calls.join(',')}`,
      );
      for (const id of [
        a.item.canonical.id,
        ...a.item.others.map((x) => x.id),
        b.item.canonical.id,
      ]) {
        const x = await inner.getById(id);
        assert.ok(
          x.ok && x.value === null,
          `${id} not written by another path`,
        );
      }
    });
  }
});

describe('cleanup failures are kept for retry (spec §3.3, F3)', () => {
  const canonId = recordId(U_A, 'case-42', 'item', 0);
  const staleId = recordId(U_A, 'case-42', 'note', 1);

  it('replacement → failed stale delete → not indexed, id kept → retry → gone → remove leaves nothing', async () => {
    const raw = new InMemoryRag();
    const failing = new Set([staleId]);
    const rag = flakyDeletes(raw, failing);
    const v1 = prep([
      draft('item', 'v1'),
      draft('note', 'a'),
      draft('note', 'b'),
    ]);
    assert.ok(v1.ok);
    await storeItems(rag, [v1.item]);
    const v2 = prep([draft('item', 'v2'), draft('note', 'a2')]);
    assert.ok(v2.ok);
    const r = await storeItems(rag, [v2.item]);
    assert.deepEqual(r.indexed, [false]);
    assert.match(r.failures[0] ?? '', /^cleanup-failed: 1 stale record/);
    const canon = await raw.getById(canonId);
    assert.ok(
      canon.ok && canon.value?.text === 'v2',
      'the new records are written',
    );
    assert.deepEqual(canon.value?.metadata.staleRecordIds, [staleId]);
    const still = await raw.getById(staleId);
    assert.ok(still.ok && still.value !== null);

    failing.clear();
    const retry = await storeItems(rag, [v2.item]);
    assert.deepEqual(retry.indexed, [true]);
    const gone = await raw.getById(staleId);
    assert.ok(gone.ok && gone.value === null);
    const settled = await raw.getById(canonId);
    assert.ok(
      settled.ok && settled.value?.metadata.staleRecordIds === undefined,
    );

    const n = await removeItem(rag, canonId);
    assert.ok(n.ok);
    for (const id of [canonId, recordId(U_A, 'case-42', 'note', 0), staleId]) {
      const x = await raw.getById(id);
      assert.ok(x.ok && x.value === null, id);
    }
  });

  it('remove retries the pending ids; a failed delete keeps the canonical and returns an error', async () => {
    const raw = new InMemoryRag();
    const failing = new Set([staleId]);
    const rag = flakyDeletes(raw, failing);
    const v1 = prep([
      draft('item', 'v1'),
      draft('note', 'a'),
      draft('note', 'b'),
    ]);
    const v2 = prep([draft('item', 'v2'), draft('note', 'a2')]);
    assert.ok(v1.ok && v2.ok);
    await storeItems(rag, [v1.item]);
    await storeItems(rag, [v2.item]);
    const failed = await removeItem(rag, canonId);
    assert.equal(failed.ok, false);
    const kept = await raw.getById(canonId);
    assert.ok(
      kept.ok && kept.value !== null,
      'the canonical stays so a retry finds the list',
    );
    failing.clear();
    const done = await removeItem(rag, canonId);
    assert.ok(done.ok);
    for (const id of [canonId, staleId]) {
      const x = await raw.getById(id);
      assert.ok(x.ok && x.value === null, id);
    }
  });
});

/**
 * `inner` behind a per-record writer (no precomputed or bulk write, so storeItems takes the
 * per-record path) whose `upsertRaw` fails for the ids in `failing`. `writes` logs every
 * write attempt in order.
 */
function flakyWrites(
  inner: IRag,
  failing: Set<string>,
): { rag: IRag; writes: string[] } {
  const w = inner.writer?.();
  assert.ok(w);
  const writes: string[] = [];
  const rag: IRag = {
    query: (e, k, o) => inner.query(e, k, o),
    healthCheck: (o) => inner.healthCheck(o),
    getById: (id, o) => inner.getById(id, o),
    writer: () => ({
      upsertRaw: async (
        id: string,
        text: string,
        meta: RagMetadata,
        o?: CallOptions,
      ) => {
        writes.push(id);
        if (failing.has(id))
          return { ok: false as const, error: new RagError('write down') };
        return w.upsertRaw(id, text, meta, o);
      },
      deleteByIdRaw: (id: string, o?: CallOptions) => w.deleteByIdRaw(id, o),
    }),
  };
  return { rag, writes };
}

describe('the canonical record is written first and tracks every id (spec §3.3, D84)', () => {
  const canonId = recordId(U_A, 'case-42', 'item', 0);
  const notes = [0, 1, 2].map((n) => recordId(U_A, 'case-42', 'note', n));
  const absent = async (rag: IRag, ids: readonly string[]) => {
    for (const id of ids) {
      const x = await rag.getById(id);
      assert.ok(x.ok && x.value === null, `${id} absent`);
    }
  };

  for (const [name, make] of MERGING_STORES) {
    it(`${name}: the canonical write fails while the notes would succeed → nothing else written; remove leaves no records`, async () => {
      const inner = make();
      const v1 = prep([draft('item', 'v1'), draft('note', 'a')]);
      const v2 = prep([
        draft('item', 'v2'),
        draft('note', 'a2'),
        draft('note', 'b2'),
        draft('note', 'c2'),
      ]);
      assert.ok(v1.ok && v2.ok);
      assert.deepEqual((await storeItems(inner, [v1.item])).indexed, [true]);
      const failing = new Set([canonId]);
      const { rag, writes } = flakyWrites(inner, failing);
      const r = await storeItems(rag, [v2.item]);
      assert.deepEqual(r.indexed, [false]);
      assert.match(r.failures[0] ?? '', /^write-failed: write down/);
      assert.equal(r.records, 0);
      assert.deepEqual(
        writes,
        [canonId],
        'no note is written after the canonical failed',
      );
      await absent(inner, [notes[1], notes[2]]);
      const canon = await inner.getById(canonId);
      assert.ok(
        canon.ok && canon.value?.text === 'v1',
        'the old canonical is untouched',
      );
      // Under the old order (notes first) notes 1 and 2 were written and listed nowhere.
      failing.clear();
      const n = await removeItem(rag, canonId);
      assert.ok(n.ok);
      await absent(inner, [canonId, ...notes]);
    });

    it(`${name}: the canonical is written, a note fails → item failed, id tracked; a replacement with fewer notes abandons nothing`, async () => {
      const inner = make();
      const v1 = prep([draft('item', 'v1'), draft('note', 'a')]);
      const v2 = prep([
        draft('item', 'v2'),
        draft('note', 'a2'),
        draft('note', 'b2'),
        draft('note', 'c2'),
      ]);
      const v3 = prep([draft('item', 'v3'), draft('note', 'a3')]);
      assert.ok(v1.ok && v2.ok && v3.ok);
      assert.deepEqual((await storeItems(inner, [v1.item])).indexed, [true]);
      const failing = new Set([notes[2]]);
      const { rag, writes } = flakyWrites(inner, failing);
      const r = await storeItems(rag, [v2.item]);
      assert.deepEqual(r.indexed, [false]);
      assert.match(r.failures[0] ?? '', /^write-failed: write down/);
      assert.equal(writes[0], canonId, 'the canonical is written first');
      const canon = await inner.getById(canonId);
      assert.ok(canon.ok && canon.value);
      assert.equal(canon.value.text, 'v2');
      assert.deepEqual(
        canon.value.metadata.recordIds,
        notes,
        'the failed note is already tracked',
      );
      const b2 = await inner.getById(notes[1]);
      assert.ok(b2.ok && b2.value?.text === 'b2');
      await absent(inner, [notes[2]]);

      failing.clear();
      const again = await storeItems(rag, [v3.item]);
      assert.deepEqual(again.indexed, [true]);
      await absent(inner, [notes[1], notes[2]]);
      const settled = await inner.getById(canonId);
      assert.ok(settled.ok && settled.value);
      assert.deepEqual(settled.value.metadata.recordIds, [notes[0]]);
      assert.equal(settled.value.metadata.staleRecordIds, undefined);
      const n = await removeItem(rag, canonId);
      assert.ok(n.ok);
      await absent(inner, [canonId, ...notes]);
    });
  }

  it('bulk path: the canonicals are one bulk write, then the other records; a failed second batch fails only items with a record in it', async () => {
    const inner = new InMemoryRag();
    const w = inner.writer();
    const batches: string[][] = [];
    const embedder = {
      embedDocument: async () => ({ vector: [1, 0] }),
      embedDocuments: async (ts: string[]) =>
        ts.map(() => ({ vector: [1, 0] })),
      embedQuery: async () => ({ vector: [1, 0] }),
    };
    const rag = {
      query: inner.query.bind(inner),
      healthCheck: inner.healthCheck.bind(inner),
      getById: inner.getById.bind(inner),
      retrievalEmbedder: embedder,
      writer: () => ({
        ...w,
        upsertManyPrecomputedRaw: async (
          items: { id: string; text: string; metadata: RagMetadata }[],
          o?: CallOptions,
        ) => {
          batches.push(items.map((i) => i.id));
          if (batches.length === 2)
            return { ok: false as const, error: new RagError('bulk down') };
          for (const i of items) await w.upsertRaw(i.id, i.text, i.metadata, o);
          return { ok: true as const, value: undefined };
        },
      }),
    } as unknown as IRag;
    const a = prep([draft('item', 'c'), draft('note', 'x')]);
    const b = prepareItem(
      {
        itemId: 'case-43',
        drafts: [{ ...draft('item', 'd'), itemId: 'case-43' }],
      },
      { canonicalKind: 'item', profile: 'p', maxRecordsPerItem: 5 },
    );
    assert.ok(a.ok && b.ok);
    const r = await storeItems(rag, [a.item, b.item]);
    assert.deepEqual(batches, [
      [a.item.canonical.id, b.item.canonical.id],
      [notes[0]],
    ]);
    assert.deepEqual(r.indexed, [false, true]);
    assert.match(
      r.failures[0] ?? '',
      /^write-failed: bulk write failed: bulk down/,
    );
    const canon = await inner.getById(canonId);
    assert.ok(canon.ok && canon.value);
    assert.deepEqual(
      canon.value.metadata.recordIds,
      [notes[0]],
      'the unwritten note is tracked',
    );
    // A replacement without the note (straight on the store, per-record path) leaves nothing behind.
    const lone = prep([draft('item', 'c2')]);
    assert.ok(lone.ok);
    assert.deepEqual((await storeItems(inner, [lone.item])).indexed, [true]);
    const n = await removeItem(inner, canonId);
    assert.ok(n.ok);
    await absent(inner, [canonId, notes[0]]);
  });
});

/** Logs every store call (read, write, delete); a rejected batch must make none. */
function counting(inner: InMemoryRag): { rag: IRag; calls: string[] } {
  const calls: string[] = [];
  const w = inner.writer();
  const rag = {
    ...inner,
    query: inner.query.bind(inner),
    getById: async (id: string, o?: CallOptions) => {
      calls.push(`getById ${id}`);
      return inner.getById(id, o);
    },
    writer: () => ({
      ...w,
      upsertRaw: async (...a: Parameters<typeof w.upsertRaw>) => {
        calls.push(`upsertRaw ${a[0]}`);
        return w.upsertRaw(...a);
      },
      deleteByIdRaw: async (id: string, o?: CallOptions) => {
        calls.push(`deleteByIdRaw ${id}`);
        return w.deleteByIdRaw(id, o);
      },
    }),
  } as IRag;
  return { rag, calls };
}

describe('duplicate item ids in one batch are rejected (spec §3.3, §17.19)', () => {
  const canonId = recordId(U_A, 'case-42', 'item', 0);
  const note0 = recordId(U_A, 'case-42', 'note', 0);
  const note1 = recordId(U_A, 'case-42', 'note', 1);
  const other = () =>
    prepareItem(
      {
        itemId: 'case-43',
        drafts: [{ ...draft('item', 'd'), itemId: 'case-43' }],
      },
      { canonicalKind: 'item', profile: 'shared-items', maxRecordsPerItem: 5 },
    );

  it('two versions of one item: rejected before any read or write, naming the duplicate; store untouched', async () => {
    const raw = new InMemoryRag();
    const v0 = prep([draft('item', 'v0')]);
    const o = other();
    const v1 = prep([draft('item', 'v1'), draft('note', 'a')]);
    const v2 = prep([draft('item', 'v2')]);
    assert.ok(v0.ok && o.ok && v1.ok && v2.ok);
    await storeItems(raw, [v0.item]);
    const { rag, calls } = counting(raw);
    const r = await storeItems(rag, [o.item, v1.item, v2.item]);
    assert.deepEqual(calls, [], 'nothing read, written or deleted');
    assert.ok(r.rejected);
    assert.match(r.rejected.message, /duplicate item ids in one batch/);
    assert.match(r.rejected.message, /user:A\/case-42 \(2×\)/);
    assert.doesNotMatch(
      r.rejected.message,
      /case-43/,
      'only the duplicates are named',
    );
    assert.deepEqual(r.indexed, [false, false, false]);
    assert.equal(r.records, 0);
    assert.deepEqual(r.failures, [
      r.rejected.message,
      r.rejected.message,
      r.rejected.message,
    ]);
    const canon = await raw.getById(canonId);
    assert.ok(
      canon.ok && canon.value?.text === 'v0',
      'the stored version is untouched',
    );
    for (const id of [note0, recordId(U_A, 'case-43', 'item', 0)]) {
      const x = await raw.getById(id);
      assert.ok(x.ok && x.value === null, id);
    }
    // The same item id under another owner is a different item: no rejection.
    const b = prepareItem(
      {
        itemId: 'case-42',
        drafts: [draft('item', 'b', { scope: 'user', userId: 'B' })],
      },
      { canonicalKind: 'item', profile: 'shared-items', maxRecordsPerItem: 5 },
    );
    assert.ok(b.ok);
    assert.equal(duplicateItemsError([v2.item, b.item]), undefined);
  });

  it('note records + replacement in one batch cannot leave an untracked record', async () => {
    // Unchecked, both versions would read the same (absent) canonical; v1's notes 0 and 1 are
    // written, v2's canonical lands last and lists only its note 0 — note 1 is listed nowhere,
    // and `remove` would leave it behind. Rejected, nothing is written.
    const raw = new InMemoryRag();
    const v1 = prep([
      draft('item', 'v1'),
      draft('note', 'a'),
      draft('note', 'b'),
    ]);
    const v2 = prep([draft('item', 'v2'), draft('note', 'a2')]);
    assert.ok(v1.ok && v2.ok);
    const r = await storeItems(raw, [v1.item, v2.item]);
    assert.ok(r.rejected);
    assert.deepEqual(r.indexed, [false, false]);
    for (const id of [canonId, note0, note1]) {
      const x = await raw.getById(id);
      assert.ok(x.ok && x.value === null, id);
    }
    // The same versions in two batches: every record stays tracked, remove leaves nothing.
    assert.deepEqual((await storeItems(raw, [v1.item])).indexed, [true]);
    assert.deepEqual((await storeItems(raw, [v2.item])).indexed, [true]);
    const n = await removeItem(raw, canonId);
    assert.ok(n.ok);
    for (const id of [canonId, note0, note1]) {
      const x = await raw.getById(id);
      assert.ok(x.ok && x.value === null, id);
    }
  });
});
