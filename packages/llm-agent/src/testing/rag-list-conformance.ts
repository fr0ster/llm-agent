import assert from 'node:assert/strict';
import type { IRag, RagListPage, RagListParams } from '../interfaces/rag.js';
import type { CallOptions } from '../interfaces/types.js';

export interface RagListConformanceCase {
  readonly name: string;
  run(makeStore: () => Promise<IRag>): Promise<void>;
}
async function page(
  store: IRag,
  params?: RagListParams,
  options?: CallOptions,
): Promise<RagListPage> {
  assert.ok(store.list);
  const result = await store.list(params, options);
  if (!result.ok) throw result.error;
  return result.value;
}
async function seed(store: IRag): Promise<void> {
  const writer = store.writer?.();
  assert.ok(writer);
  for (let i = 0; i < 6; i++) {
    const result = await writer.upsertRaw(
      `id-${i}`,
      i === 0 ? '' : `text-${i}`,
      {
        userId: i % 2 ? 'other' : 'owner',
        sessionId: 'session',
        namespace: 'ns',
        ttl: 1,
        nested: { values: [1, 2] },
      },
    );
    if (!result.ok) throw result.error;
  }
}
async function traverse(store: IRag, params: RagListParams): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const result = await page(store, { ...params, cursor });
    ids.push(...result.records.map((record) => record.id));
    cursor = result.cursor;
    assert.ok(ids.length <= 6, 'Traversal must terminate without duplicates');
  } while (cursor !== undefined);
  return ids;
}
export const ragListConformanceCases: readonly RagListConformanceCase[] = [
  {
    name: 'empty stores and isolated stores',
    async run(makeStore) {
      const store = await makeStore();
      assert.deepEqual(await page(store), { records: [] });
      await seed(store);
      assert.deepEqual(await page(await makeStore()), { records: [] });
    },
  },
  {
    name: 'bounded deterministic pages include expired records and omit vectors, scores and text',
    async run(makeStore) {
      const store = await makeStore();
      await seed(store);
      const ids = await traverse(store, { limit: 2 });
      assert.equal(new Set(ids).size, 6);
      assert.deepEqual(await traverse(store, { limit: 3 }), ids);
      const result = await page(store, { limit: 2 });
      assert.ok(result.records.length <= 2);
      for (const record of result.records)
        assert.deepEqual(Object.keys(record).sort(), ['id', 'metadata']);
      const full = await page(store, { includeText: true });
      assert.equal(
        full.records.find((record) => record.id === 'id-0')?.text,
        '',
      );
      assert.equal((await store.getById('id-0')).ok, true);
    },
  },
  {
    name: 'strict filters intersect caller scope and conflict terminates',
    async run(makeStore) {
      const store = await makeStore();
      await seed(store);
      assert.equal(
        (
          await traverse(store, {
            limit: 1,
            filter: { userId: 'owner', sessionId: 'session', namespace: 'ns' },
          })
        ).length,
        3,
      );
      assert.equal(
        (await traverse(store, { limit: 2, filter: { userId: 'missing' } }))
          .length,
        0,
      );
      assert.deepEqual(
        await page(
          store,
          { filter: { userId: 'owner' } },
          { ragFilter: { userId: 'other' } },
        ),
        { records: [] },
      );
      const scoped = await page(store, {}, { ragFilter: { userId: 'owner' } });
      assert.equal(scoped.records.length, 3);
    },
  },
  {
    name: 'cursors reject malformed, foreign-store, changed-filter and scan tokens',
    async run(makeStore) {
      const store = await makeStore();
      await seed(store);
      assert.ok(store.list);
      const first = await page(store, { limit: 1 });
      assert.ok(first.cursor);
      const sibling = await makeStore();
      assert.ok(sibling.list);
      for (const result of [
        await store.list({ cursor: 'garbage' }),
        await sibling.list({ cursor: first.cursor }),
        await store.list({ cursor: first.cursor, filter: { userId: 'owner' } }),
        await store.list({ cursor: 'azow' }),
      ]) {
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.error.code, 'INVALID_ARGUMENT');
      }
      await page(store, { cursor: first.cursor, limit: 3, includeText: true });
    },
  },
  {
    name: 'invalid limits and cancellation return errors',
    async run(makeStore) {
      const store = await makeStore();
      assert.ok(store.list);
      for (const limit of [
        0,
        -1,
        1.5,
        1001,
        Number.NaN,
        Number.POSITIVE_INFINITY,
      ]) {
        const result = await store.list({ limit });
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.error.code, 'INVALID_ARGUMENT');
      }
      await page(store, { limit: 1000 });
      const result = await store.list({}, { signal: AbortSignal.abort() });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, 'ABORTED');
    },
  },
  {
    name: 'returned metadata is detached and writes/deletion are visible to fresh traversal',
    async run(makeStore) {
      const store = await makeStore();
      await seed(store);
      const first = await page(store);
      const record = first.records[0];
      record.metadata.userId = 'mutated';
      const nested = record.metadata.nested;
      if (
        nested &&
        typeof nested === 'object' &&
        !Array.isArray(nested) &&
        'values' in nested
      )
        Object.defineProperty(nested, 'values', { value: [99] });
      const fresh = (await page(store)).records.find(
        (entry) => entry.id === record.id,
      );
      assert.ok(fresh);
      assert.notEqual(fresh.metadata.userId, 'mutated');
      assert.deepEqual(fresh.metadata.nested, { values: [1, 2] });
      const writer = store.writer?.();
      assert.ok(writer);
      const deleted = await writer.deleteByIdRaw(record.id);
      assert.ok(deleted.ok);
      const ids = await traverse(store, { limit: 1 });
      assert.equal(ids.length, 5);
      assert.ok(!ids.includes(record.id));
      const written = await writer.upsertRaw('new-id', 'replacement', {});
      assert.ok(written.ok);
      assert.ok((await traverse(store, { limit: 2 })).includes('new-id'));
    },
  },
  {
    name: 'identity values must be strings and all scope constraints apply',
    async run(makeStore) {
      const store = await makeStore();
      const writer = store.writer?.();
      assert.ok(writer);
      for (const [id, metadata] of [
        ['missing', {}],
        ['number', { userId: 7 }],
        ['array', { userId: ['owner'] }],
        ['boolean', { userId: true }],
        ['owned', { userId: 'owner', sessionId: 's', namespace: 'n' }],
      ] as const) {
        const result = await writer.upsertRaw(id, id, metadata);
        assert.ok(result.ok);
      }
      const result = await page(
        store,
        { filter: { sessionId: 's' } },
        { ragFilter: { userId: 'owner', namespace: 'n' } },
      );
      assert.deepEqual(
        result.records.map((record) => record.id),
        ['owned'],
      );
      assert.deepEqual(
        (await page(store, { filter: { userId: 'owner' } })).records.map(
          (record) => record.id,
        ),
        ['owned'],
      );
    },
  },
  {
    name: 'default limit is 100 and continuation handles exact boundaries',
    async run(makeStore) {
      const store = await makeStore();
      const writer = store.writer?.();
      assert.ok(writer);
      for (let i = 0; i < 101; i++) {
        const written = await writer.upsertRaw(`boundary-${i}`, '', {});
        assert.ok(written.ok);
      }
      const first = await page(store);
      assert.equal(first.records.length, 100);
      assert.ok(first.cursor);
      const second = await page(store, { cursor: first.cursor });
      assert.equal(second.records.length, 1);
      // A backend may require one final empty continuation page.
      if (second.cursor !== undefined) {
        const terminal = await page(store, { cursor: second.cursor });
        assert.deepEqual(terminal, { records: [] });
      }
      const exact = await page(store, { limit: 101 });
      assert.equal(exact.records.length, 101);
      if (exact.cursor !== undefined)
        assert.deepEqual(await page(store, { cursor: exact.cursor }), {
          records: [],
        });
    },
  },
];
