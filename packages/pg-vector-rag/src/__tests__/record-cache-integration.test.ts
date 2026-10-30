import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type IRag,
  QueryEmbedding,
  type RagError,
  type Result,
  symmetricEmbedder,
} from '@mcp-abap-adt/llm-agent';
import { type PgClient, PgVectorRag } from '../pg-vector-rag.js';
import { PgVectorRagProvider } from '../pg-vector-rag-provider.js';
import type { RecordCacheOptions } from '../record-cache.js';
import { storingPg } from './storing-pg.js';

const embedder = symmetricEmbedder({
  embed: async () => ({ vector: [1, 0, 0] }),
});
function value<T>(result: Result<T, RagError>): T {
  if (!result.ok) throw result.error;
  return result.value;
}
function deferred<T>() {
  let resolveValue: ((result: T) => void) | undefined;
  let rejectValue: ((error: Error) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolveValue = resolve;
    rejectValue = reject;
  });
  return {
    promise,
    resolve(result: T) {
      assert.ok(resolveValue);
      resolveValue(result);
    },
    reject(error: Error) {
      assert.ok(rejectValue);
      rejectValue(error);
    },
  };
}
function setup(
  layout: 'shared' | 'per-collection',
  recordCache?: RecordCacheOptions,
  connectionCache?: RecordCacheOptions,
) {
  const db = storingPg({ sharedDimension: 3 });

  const client: PgClient = { ...db };
  const config = {
    collectionName: 'unused',
    dimension: 3,
    recordCache: connectionCache,
  };
  const provider = new PgVectorRagProvider({
    name: 'test',
    connection: config,
    embedder,
    layout,
    clientFactory: () => client,
    recordCache,
  });
  async function open(name = 'docs'): Promise<PgVectorRag> {
    const rag = value(
      await provider.openCollection({ storeName: name, name, scope: 'global' }),
    ).rag;
    assert.ok(rag instanceof PgVectorRag);
    return rag;
  }
  function direct(name = 'docs', cache: RecordCacheOptions = false) {
    return new PgVectorRag(
      {
        ...config,
        collectionName: name,
        layout,
        autoCreateSchema: false,
        embedder,
        recordCache: cache,
      },
      client,
    );
  }
  return { db, client, provider, open, direct };
}
async function put(store: IRag, id: string, text = id) {
  const writer = store.writer?.();
  assert.ok(writer);
  value(
    await writer.upsertRaw(id, text, {
      userId: id === 'a' ? 'target' : 'other',
    }),
  );
}
async function text(store: IRag, id: string) {
  return value(await store.getById(id))?.text;
}
for (const layout of ['per-collection', 'shared'] as const)
  describe(`Pg cache integration (${layout})`, () => {
    it('shares handles, isolates stores, has no negative cache and preserves unrelated ids on every write entry', async () => {
      const env = setup(layout);
      const store = await env.open();
      const sibling = await env.open();
      const other = await env.open('other');
      await put(store, 'a');
      await put(store, 'b');
      await put(other, 'a', 'other-store');
      assert.equal(await text(store, 'missing'), undefined);
      await put(env.direct(), 'missing', 'now-visible');
      assert.equal(await text(store, 'missing'), 'now-visible');
      await text(store, 'a');
      await text(store, 'b');
      await text(other, 'a');
      await put(env.direct(), 'a', 'external');
      await put(env.direct(), 'b', 'external-b');
      assert.equal(await text(sibling, 'a'), 'a');
      const writer = store.writer?.();
      assert.ok(writer);
      const writes = [
        () => put(sibling, 'a', 'raw'),
        async () => {
          assert.ok(writer.upsertPrecomputedRaw);
          value(
            await writer.upsertPrecomputedRaw(
              'a',
              'precomputed-raw',
              [1, 0, 0],
              {},
            ),
          );
        },
        async () => {
          value(await sibling.upsert('class', { id: 'a' }));
        },
        async () => {
          value(
            await sibling.upsertPrecomputed('class-precomputed', [1, 0, 0], {
              id: 'a',
            }),
          );
        },
        async () => {
          value(await writer.deleteByIdRaw('a'));
        },
      ];
      for (const write of writes) {
        await text(store, 'a');
        await write();
        assert.notEqual(await text(store, 'a'), 'a');
        assert.equal(await text(store, 'b'), 'b');
        assert.equal(await text(other, 'a'), 'other-store');
      }
      assert.ok(writer.clearAll);
      value(await writer.clearAll());
      assert.equal(await text(sibling, 'b'), undefined);
      assert.equal(await text(other, 'a'), 'other-store');
    });
    it('fixed TTL exposes external updates and expiry errors never serve stale data', async (t) => {
      t.mock.timers.enable({ apis: ['Date'], now: 1000 });
      const env = setup(layout, { ttlMs: 100 });
      const store = await env.open();
      await put(store, 'a');
      await text(store, 'a');
      await put(env.direct(), 'a', 'external');
      t.mock.timers.tick(99);
      assert.equal(await text(store, 'a'), 'a');
      t.mock.timers.tick(1);
      assert.equal(await text(store, 'a'), 'external');
      t.mock.timers.tick(100);
      env.client.query = async () => {
        throw new Error('offline');
      };
      assert.equal((await store.getById('a')).ok, false);
    });
    it('disabled cache and authoritative query/list/scan see external updates without populating getById', async () => {
      const env = setup(layout);
      const store = await env.open();
      await put(store, 'a');
      await text(store, 'a');
      await put(env.direct(), 'a', 'external');
      assert.ok(store.list);
      assert.equal(
        value(await store.list({ includeText: true })).records[0].text,
        'external',
      );
      assert.equal(
        value(await env.direct().scan()).records[0].text,
        'external',
      );
      assert.equal(
        value(await store.query(new QueryEmbedding('q', embedder), 1))[0].text,
        'external',
      );
      assert.equal(await text(store, 'a'), 'a');
      const fresh = env.direct('docs', {});
      await fresh.list();
      await fresh.scan();
      await fresh.query(new QueryEmbedding('q', embedder), 1);
      await put(env.direct(), 'a', 'later');
      assert.equal(await text(fresh, 'a'), 'later');
      const off = env.direct();
      assert.equal(await text(off, 'a'), 'later');
      await put(env.direct(), 'a', 'latest');
      assert.equal(await text(off, 'a'), 'latest');
    });
    it('filtered deletion selects DB membership and preserves unrelated cache entries', async () => {
      const env = setup(layout);
      const store = await env.open();
      await put(store, 'a');
      await put(store, 'b');
      await text(store, 'a');
      await text(store, 'b');
      await put(env.direct(), 'b', 'external-b');
      assert.equal(
        value(await env.direct().deleteWhere({ userId: 'missing' })).deleted,
        0,
      );
      assert.equal(
        value(await store.deleteWhere({ userId: 'target' })).deleted,
        1,
      );
      assert.equal(await text(store, 'a'), undefined);
      assert.equal(await text(store, 'b'), 'b');
      // Cached membership is stale: DB selection must still evict b when its owner changes.
      value(
        await env
          .direct()
          .upsert('changed-owner', { id: 'b', userId: 'target' }),
      );
      assert.equal(
        value(await store.deleteWhere({ userId: 'target' })).deleted,
        1,
      );
      assert.equal(await text(store, 'b'), undefined);
    });
    it('suppresses delayed reads racing successful/failed writes and aborts late list/get results', async () => {
      const env = setup(layout);
      const store = await env.open();
      await put(store, 'a');
      const original = env.client.query;
      const entered = deferred<void>();
      const release = deferred<void>();
      let delay = true;
      env.client.query = async (sql, params) => {
        const rows = await original(sql, params);
        if (
          delay &&
          /WHERE .*id.* =|WHERE .*"ID" =/.test(sql) &&
          sql.startsWith('SELECT')
        ) {
          delay = false;
          entered.resolve();
          await release.promise;
        }
        return rows;
      };
      const reading = store.getById('a');
      await entered.promise;
      await put(store, 'a', 'replacement');
      release.resolve();
      await reading;
      assert.equal(await text(store, 'a'), 'replacement');
      const ctl = new AbortController();
      env.client.query = async (sql, params) => {
        const rows = await original(sql, params);
        ctl.abort();
        return rows;
      };
      assert.ok(store.list);
      const listed = await store.list({}, { signal: ctl.signal });
      assert.equal(listed.ok, false);
      if (!listed.ok) assert.equal(listed.error.code, 'ABORTED');
      const control = new AbortController();
      env.client.query = async (sql, params) => {
        const rows = await original(sql, params);
        control.abort();
        return rows;
      };
      const read = await env.direct().getById('a', { signal: control.signal });
      assert.equal(read.ok, false);
      if (!read.ok) assert.equal(read.error.code, 'ABORTED');
    });

    it('uncertain writes evict only submitted ids and pending reads cannot cache uncertain data', async () => {
      const env = setup(layout);
      const store = await env.open();
      await put(store, 'a');
      await put(store, 'b');
      await text(store, 'a');
      await text(store, 'b');
      await put(env.direct(), 'b', 'external-b');
      const original = env.client.query;
      const entered = deferred<void>();
      const release = deferred<void>();
      env.client.query = async (sql, params) => {
        if (/^(INSERT|DELETE)/.test(sql)) {
          entered.resolve();
          await release.promise;
          throw new Error('uncertain commit');
        }
        return original(sql, params);
      };
      const writing = store.upsertPrecomputed('attempt', [1, 0, 0], {
        id: 'a',
      });
      await entered.promise;
      assert.equal(await text(store, 'a'), 'a');
      release.resolve();
      assert.equal((await writing).ok, false);
      env.client.query = original;
      await put(env.direct(), 'a', 'visible-after-failure');
      assert.equal(await text(store, 'a'), 'visible-after-failure');
      assert.equal(await text(store, 'b'), 'b');
    });
    it('store deletion retires old handles, suppresses delayed reads and preserves other stores', async () => {
      const env = setup(layout);
      const store = await env.open();
      const other = await env.open('other');
      await put(store, 'a');
      await put(other, 'b');
      await text(other, 'b');
      const original = env.client.query;
      const entered = deferred<void>();
      const release = deferred<void>();
      let delay = true;
      env.client.query = async (sql, params) => {
        const rows = await original(sql, params);
        if (
          delay &&
          sql.startsWith('SELECT') &&
          /WHERE .*id.* =|WHERE .*"ID" =/.test(sql)
        ) {
          delay = false;
          entered.resolve();
          await release.promise;
        }
        return rows;
      };
      const reading = store.getById('a');
      await entered.promise;
      const deleted = await env.provider.deleteCollection('docs');
      value(deleted);
      release.resolve();
      await reading;
      env.client.query = original;
      if (layout === 'shared') assert.equal(await text(store, 'a'), undefined);
      await put(env.direct('other'), 'b', 'external-b');
      assert.equal(await text(other, 'b'), 'b');
    });
    it('list errors propagate, invalid metadata is rejected and text projection is selective', async () => {
      const env = setup(layout);
      const store = await env.open();
      await put(store, 'a');
      const original = env.client.query;
      await store.list();
      const listing = env.db.statements
        .filter((sql) => sql.includes('COLLATE "C"'))
        .at(-1);
      assert.ok(listing);
      assert.ok(!listing.includes('"text"'));
      env.client.query = async () => {
        throw new Error('offline');
      };
      assert.equal((await store.list()).ok, false);
      env.client.query = async () => ({
        rows: [{ id: 'a', metadata: { namespace: 42 } }],
        rowCount: 1,
      });
      const invalid = await store.list();
      assert.equal(invalid.ok, false);
      if (!invalid.ok) assert.equal(invalid.error.code, 'RAG_INVALID_METADATA');
      env.client.query = original;
    });

    it('provider config overrides connection config and scoped reads bypass shared entries', async () => {
      for (const disabled of [true, false]) {
        const env = setup(layout, disabled ? false : {}, disabled ? {} : false);
        const store = await env.open();
        await put(store, 'a');
        await text(store, 'a');
        await put(env.direct(), 'a', 'external');
        assert.equal(await text(store, 'a'), disabled ? 'external' : 'a');
        assert.equal(
          value(await store.getById('a', { ragFilter: { userId: 'scope' } }))
            ?.text,
          'external',
        );
        env.provider.close();
      }
    });
    it('pre-submission validation leaves unrelated and written cached values intact', async () => {
      const env = setup(layout);
      const store = await env.open();
      await put(store, 'a');
      await text(store, 'a');
      await put(env.direct(), 'a', 'external');
      assert.equal(
        (await store.upsertPrecomputed('invalid', [NaN, 0, 0], { id: 'a' })).ok,
        false,
      );
      assert.equal(await text(store, 'a'), 'a');
    });
    it('a delayed read before a failed write cannot restore the previous cache entry', async () => {
      const env = setup(layout);
      const store = await env.open();
      await put(store, 'a');
      const originalRead = env.client.query;
      const originalWrite = env.client.query;
      const entered = deferred<void>();
      const release = deferred<void>();
      let delay = true;
      env.client.query = async (sql, params) => {
        const result = await originalRead(sql, params);
        if (
          delay &&
          sql.startsWith('SELECT') &&
          /WHERE .*id.* =|WHERE .*"ID" =/.test(sql)
        ) {
          delay = false;
          entered.resolve();
          await release.promise;
        }
        return result;
      };
      const reading = store.getById('a');
      await entered.promise;
      const delayedRead = env.client.query;
      env.client.query = async (sql, params) => {
        if (/^INSERT/.test(sql)) throw new Error('lost connection');
        return delayedRead(sql, params);
      };
      assert.equal(
        (await store.upsertPrecomputed('attempt', [1, 0, 0], { id: 'a' })).ok,
        false,
      );
      release.resolve();
      await reading;
      env.client.query = originalWrite;
      env.client.query = originalRead;
      await put(env.direct(), 'a', 'new-visible');
      assert.equal(await text(store, 'a'), 'new-visible');
    });

    it('uncertain clear evicts its store after submission and leaves other stores cached', async () => {
      const env = setup(layout);
      const store = await env.open();
      const other = await env.open('other');
      await put(store, 'a');
      await put(other, 'a', 'other');
      await text(store, 'a');
      await text(other, 'a');
      const original = env.client.query;
      env.client.query = async (sql, params) => {
        const result = await original(sql, params);
        if (/^(TRUNCATE|DELETE)/.test(sql)) throw new Error('uncertain clear');
        return result;
      };
      const writer = store.writer();
      assert.ok(writer.clearAll);
      assert.equal((await writer.clearAll()).ok, false);
      env.client.query = original;
      assert.equal(await text(store, 'a'), undefined);
      await put(env.direct('other'), 'a', 'external');
      assert.equal(await text(other, 'a'), 'other');
    });

    it('handles opened during store deletion cannot serve or populate cache entries', async () => {
      const env = setup(layout);
      const old = await env.open();
      await put(old, 'a');
      await text(old, 'a');
      const original = env.client.query;
      const entered = deferred<void>();
      const release = deferred<void>();
      env.client.query = async (sql, params) => {
        if (
          sql.startsWith('DROP TABLE') ||
          (sql.startsWith('DELETE') && sql.includes('"rag_documents"'))
        ) {
          entered.resolve();
          await release.promise;
        }
        return original(sql, params);
      };
      const deleting = env.provider.deleteCollection('docs');
      await entered.promise;
      const during = await env.open();
      assert.equal(await text(during, 'a'), 'a');
      await put(env.direct(), 'a', 'racing');
      assert.equal(await text(during, 'a'), 'racing');
      release.resolve();
      value(await deleting);
      env.client.query = original;
      const result = await during.getById('a');
      if (result.ok) assert.equal(result.value, null);
    });
  });
