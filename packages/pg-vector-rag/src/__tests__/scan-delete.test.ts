import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_SCAN_PAGE_SIZE,
  INVALID_ARGUMENT,
  type IRagFilteredDeleter,
  type IRagScanner,
  RagError,
  type RagScanRecord,
  symmetricEmbedder,
} from '@mcp-abap-adt/llm-agent';
import {
  CONFORMANCE_EMBEDDING_DIM,
  conformanceEmbedder,
  isScanDeleteCaseSkipped,
  type ScanDeleteSubject,
  scanDeleteConformanceCases,
} from '@mcp-abap-adt/llm-agent/testing/scan-delete-conformance';
import { PgVectorRag } from '../pg-vector-rag.js';
import { PgVectorRagProvider } from '../pg-vector-rag-provider.js';
import { perCollectionStoreSql, sharedStoreSql } from '../store-sql.js';
import { type StoringPg, storingPg } from './storing-pg.js';

const DDL = /\b(CREATE|DROP|TRUNCATE|ALTER)\b|IF NOT EXISTS/;
const DIM = CONFORMANCE_EMBEDDING_DIM;
const embedder = symmetricEmbedder(conformanceEmbedder());

type Store = PgVectorRag & IRagScanner & IRagFilteredDeleter;
type Layout = 'shared' | 'per-collection';

function open(
  pg: StoringPg,
  collection: string,
  layout: Layout,
  dimension = DIM,
): Store {
  return new PgVectorRag(
    {
      collectionName: collection,
      dimension,
      layout,
      autoCreateSchema: false,
      embedder,
    },
    pg,
  ) as Store;
}

const fake = (): StoringPg => storingPg({ sharedDimension: DIM });

async function put(
  store: Store,
  id: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  const r = await store.upsert(`text ${id}`, { ...metadata, id });
  assert.ok(r.ok);
}

async function scanAll(
  store: Store,
  pageSize?: number,
): Promise<RagScanRecord[]> {
  const out: RagScanRecord[] = [];
  let cursor: string | undefined;
  do {
    const r = await store.scan({ pageSize, cursor });
    assert.ok(r.ok);
    out.push(...r.value.records);
    cursor = r.value.cursor;
  } while (cursor !== undefined);
  return out;
}

const STRICT = (key: string, n: number): string =>
  `CASE WHEN jsonb_typeof("metadata"->'${key}') = 'string' THEN "metadata"->>'${key}' END = $${n}`;

describe('scan/delete SQL', () => {
  it('shared scanPage: collection, binary cursor, strict filter, schema-qualified', () => {
    const sql = sharedStoreSql('docs', 'rag_documents', 'rag');
    assert.deepEqual(sql.scanPage(undefined, 5), {
      sql: 'SELECT "id", "text", "metadata" FROM "rag"."rag_documents" WHERE "collection" = $1 ORDER BY "id" LIMIT 5',
      params: ['docs'],
    });
    assert.deepEqual(sql.scanPage('k', 5, { userId: 'u1', namespace: 'ns' }), {
      sql: `SELECT "id", "text", "metadata" FROM "rag"."rag_documents" WHERE "collection" = $1 AND "id" > $2 AND ${STRICT('userId', 3)} AND ${STRICT('namespace', 4)} ORDER BY "id" LIMIT 5`,
      params: ['docs', 'k', 'u1', 'ns'],
    });
  });

  it('per-collection scanPage has no collection predicate, same strict filter', () => {
    const sql = perCollectionStoreSql('docs', 3);
    assert.deepEqual(sql.scanPage(undefined, 5), {
      sql: 'SELECT "id", "text", "metadata" FROM "docs" ORDER BY "id" LIMIT 5',
      params: [],
    });
    assert.deepEqual(sql.scanPage('k', 5, { sessionId: 's1' }), {
      sql: `SELECT "id", "text", "metadata" FROM "docs" WHERE "id" > $1 AND ${STRICT('sessionId', 2)} ORDER BY "id" LIMIT 5`,
      params: ['k', 's1'],
    });
  });

  it('the delete builder itself refuses an empty filter', () => {
    for (const sql of [
      sharedStoreSql('docs', 'rag_documents'),
      perCollectionStoreSql('docs', 3),
    ])
      assert.throws(
        () => sql.deleteWhere({}),
        (e: unknown) => e instanceof RagError && e.code === INVALID_ARGUMENT,
      );
  });

  it('deleteWhere is one DELETE ... RETURNING "id", scoped to the collection in shared', () => {
    assert.deepEqual(
      sharedStoreSql('docs', 'rag_documents').deleteWhere({ userId: 'u1' }),
      {
        sql: `DELETE FROM "rag_documents" WHERE "collection" = $1 AND ${STRICT('userId', 2)} RETURNING "id"`,
        params: ['docs', 'u1'],
      },
    );
    assert.deepEqual(
      perCollectionStoreSql('docs', 3).deleteWhere({ userId: 'u1' }),
      {
        sql: `DELETE FROM "docs" WHERE ${STRICT('userId', 1)} RETURNING "id"`,
        params: ['u1'],
      },
    );
  });
});

for (const layout of ['shared', 'per-collection'] as const) {
  describe(`PgVectorRag scan/deleteWhere (${layout})`, () => {
    it('pages by the id key covering every record once, never returns a vector', async () => {
      const pg = fake();
      const store = open(pg, 'kb', layout);
      for (const id of ['c', 'a', 'e', 'B', 'd']) await put(store, id);
      const first = await store.scan({ pageSize: 2 });
      assert.ok(first.ok);
      assert.deepEqual(
        first.value.records.map((r) => r.id),
        ['B', 'a'],
      );
      assert.equal(first.value.cursor, first.value.records[1].id);
      assert.equal(first.value.records[1].metadata.id, 'a');
      assert.equal(first.value.records[1].text, 'text a');
      assert.ok(!('vector' in first.value.records[0]));
      const all = (await scanAll(store, 2)).map((r) => r.id);
      assert.equal(all.length, 5);
      assert.deepEqual([...all].sort(), ['B', 'a', 'c', 'd', 'e']);
      assert.equal(new Set(all).size, 5);
      assert.equal(DEFAULT_SCAN_PAGE_SIZE, 500);
      assert.ok(pg.statements.some((s) => s.endsWith('LIMIT 2')));
      assert.ok(pg.statements.some((s) => s.endsWith('LIMIT 500')) === false);
    });

    it('the filter is applied in SQL and is strict on strings', async () => {
      const pg = fake();
      const store = open(pg, 'kb', layout);
      await put(store, 'a', { userId: 'u1' });
      await put(store, 'b', { userId: 123 });
      await put(store, 'c', { userId: 'u2', ttl: 1 });
      const r = await store.scan({ filter: { userId: 'u1' } });
      assert.ok(r.ok);
      assert.deepEqual(
        r.value.records.map((x) => x.id),
        ['a'],
      );
      const expired = await store.scan({ filter: { userId: 'u2' } });
      assert.ok(expired.ok);
      assert.deepEqual(
        expired.value.records.map((x) => x.id),
        ['c'],
      );
      const num = await store.scan({ filter: { userId: '123' } });
      assert.ok(num.ok);
      assert.deepEqual(num.value.records, []);
    });

    it('refuses a pageSize that is not a positive integer, before any SQL', async () => {
      const pg = fake();
      const store = open(pg, 'kb', layout);
      const before = pg.statements.length;
      for (const pageSize of [Number.NaN, Infinity, 0, -1, 2.5]) {
        const r = await store.scan({ pageSize });
        assert.ok(!r.ok);
        assert.equal(r.error.code, INVALID_ARGUMENT);
      }
      assert.equal(pg.statements.length, before);
    });

    it('an aborted signal is ABORTED for scan and deleteWhere, before any SQL', async () => {
      const pg = fake();
      const store = open(pg, 'kb', layout);
      const before = pg.statements.length;
      const signal = AbortSignal.abort();
      const s = await store.scan(undefined, { signal });
      assert.ok(!s.ok);
      assert.equal(s.error.code, 'ABORTED');
      const d = await store.deleteWhere({ userId: 'u1' }, { signal });
      assert.ok(!d.ok);
      assert.equal(d.error.code, 'ABORTED');
      assert.equal(pg.statements.length, before);
    });

    it('a full last page is followed by an empty one', async () => {
      const pg = fake();
      const store = open(pg, 'kb', layout);
      for (const id of ['a', 'b']) await put(store, id);
      assert.deepEqual(
        (await scanAll(store, 2)).map((r) => r.id),
        ['a', 'b'],
      );
    });

    it('deleteWhere is one statement and counts the returned rows', async () => {
      const pg = fake();
      const store = open(pg, 'kb', layout);
      for (let i = 0; i < 2100; i++) {
        await put(store, `id${String(i).padStart(5, '0')}`, {
          userId: i % 3 === 0 ? 'u1' : 'u2',
        });
      }
      const r = await store.deleteWhere({ userId: 'u1' });
      assert.ok(r.ok);
      assert.equal(r.value.deleted, 700);
      assert.equal((await scanAll(store)).length, 1400);
      assert.equal(
        pg.statements.filter((s) => s.startsWith('DELETE')).length,
        1,
      );
    });

    it('deleteWhere refuses an empty filter before any SQL', async () => {
      const pg = fake();
      const store = open(pg, 'kb', layout);
      const before = pg.statements.length;
      const r = await store.deleteWhere({});
      assert.ok(!r.ok);
      assert.equal(r.error.code, INVALID_ARGUMENT);
      assert.equal(pg.statements.length, before);
    });

    it('sends no DDL across the lifecycle', async () => {
      const pg = fake();
      const store = open(pg, 'kb', layout);
      await put(store, 'a', { userId: 'u1' });
      await scanAll(store);
      await store.deleteWhere({ userId: 'u1' });
      for (const s of pg.statements) assert.doesNotMatch(s, DDL);
    });
  });
}

describe('PgVectorRag scan/deleteWhere (shared)', () => {
  it('takes the id from the id column, not from the metadata JSON', async () => {
    const pg = fake();
    pg.insertSharedRow({
      collection: 'kb',
      id: 'real',
      text: 't',
      vector: Array(DIM).fill(0),
      metadata: { id: 'other', userId: 'u1' },
    });
    const r = await open(pg, 'kb', 'shared').scan();
    assert.ok(r.ok);
    assert.equal(r.value.records[0].id, 'real');
    assert.equal(r.value.records[0].metadata.id, 'real');
  });

  it('an abort that lands after the check, before the DELETE, sends no DELETE', async () => {
    const pg = fake();
    const ctl = new AbortController();
    const client = {
      ...pg,
      query: async (sql: string, params?: readonly unknown[]) => {
        const r = await pg.query(sql, params);
        if (sql.includes('pg_attribute')) ctl.abort();
        return r;
      },
    };
    const store = new PgVectorRag(
      {
        collectionName: 'kb',
        dimension: DIM,
        layout: 'shared',
        autoCreateSchema: false,
        embedder,
      },
      client,
    ) as Store;
    const d = await store.deleteWhere({ userId: 'u1' }, { signal: ctl.signal });
    assert.ok(!d.ok);
    assert.equal(d.error.code, 'ABORTED');
    assert.match(d.error.message, /0 record/);
    assert.ok(pg.statements.every((q) => !q.startsWith('DELETE')));
  });

  it('runs the check first and returns its error unchanged', async () => {
    const pg = storingPg({ sharedDimension: 8 });
    const store = open(pg, 'kb', 'shared', DIM);
    const s = await store.scan();
    assert.ok(!s.ok);
    assert.equal(s.error.code, 'SHARED_LAYOUT_NOT_DEPLOYED');
    const d = await store.deleteWhere({ userId: 'u1' });
    assert.ok(!d.ok);
    assert.equal(d.error.code, 'SHARED_LAYOUT_NOT_DEPLOYED');
    assert.ok(
      pg.statements.every(
        (q) => !q.startsWith('SELECT "id"') && !q.startsWith('DELETE'),
      ),
    );
  });

  it('a check that cannot run is HEALTH_CHECK_ERROR', async () => {
    const failing = {
      ...fake(),
      query: async (): Promise<never> => {
        throw new Error('down');
      },
    };
    const store = new PgVectorRag(
      { collectionName: 'kb', dimension: DIM, layout: 'shared', embedder },
      failing,
    ) as Store;
    const r = await store.scan();
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'HEALTH_CHECK_ERROR');
  });
});

// The kit over the storing fake, in each layout.
for (const layout of ['shared', 'per-collection'] as const) {
  describe(`scan/delete conformance — PgVectorRag ${layout} (storing fake)`, () => {
    const subject = async (): Promise<ScanDeleteSubject> => {
      const pg = fake();
      return {
        store: async () => open(pg, 'kit', layout),
        catalog: async () => {
          const provider = new PgVectorRagProvider({
            name: 'pg',
            embedder,
            connection: { collectionName: '__unused', dimension: DIM },
            layout,
            clientFactory: () => pg,
          });
          return {
            provider,
            async create(name) {
              const r = await provider.createCollection(name, {
                scope: 'user',
                userId: 'u1',
                attributes: { seeded: true },
              });
              if (!r.ok) throw r.error;
            },
          };
        },
        ...(layout === 'shared'
          ? { sibling: async () => open(pg, 'sib', layout) }
          : {}),
      };
    };
    for (const c of scanDeleteConformanceCases) {
      it(c.name, async (t) => {
        try {
          await c.run(subject);
        } catch (err) {
          if (!isScanDeleteCaseSkipped(err)) throw err;
          t.skip(err.message);
        }
      });
    }
  });
}
