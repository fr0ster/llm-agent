import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_SCAN_PAGE_SIZE,
  decodeIdScanCursor,
  INVALID_ARGUMENT,
  type IRagFilteredDeleter,
  type IRagScanner,
  QueryEmbedding,
  RagError,
  type RagScanRecord,
  staticLogin,
  symmetricEmbedder,
} from '@mcp-abap-adt/llm-agent';
import {
  CONFORMANCE_EMBEDDING_DIM,
  conformanceEmbedder,
  isScanDeleteCaseSkipped,
  type ScanDeleteSubject,
  scanDeleteConformanceCases,
} from '@mcp-abap-adt/llm-agent/testing/scan-delete-conformance';
import { HanaVectorRag } from '../hana-vector-rag.js';
import { HanaVectorRagProvider } from '../hana-vector-rag-provider.js';
import { perCollectionStoreSql, sharedStoreSql } from '../store-sql.js';
import { type StoringHana, storingHana } from './storing-hana.js';

const DDL = /\b(CREATE|DROP|TRUNCATE|ALTER)\b|IF NOT EXISTS/;
const DIM = CONFORMANCE_EMBEDDING_DIM;
const embedder = symmetricEmbedder(conformanceEmbedder());

type Store = HanaVectorRag & IRagScanner & IRagFilteredDeleter;

function open(
  hana: StoringHana,
  collection: string,
  layout: 'shared' | 'per-collection',
  dimension = DIM,
): Store {
  if (layout === 'per-collection') hana.createCollectionTable(collection);
  return new HanaVectorRag(
    {
      collectionName: collection,
      dimension,
      credential: staticLogin('u', 'p'),
      layout,
      autoCreateSchema: false,
      embedder,
    },
    hana.client,
  ) as Store;
}

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

describe('scan/delete SQL', () => {
  it('shared scanPage', () => {
    const sql = sharedStoreSql('docs', 'RAG_DOCUMENTS');
    assert.deepEqual(sql.scanPage(undefined, 5), {
      sql: 'SELECT "ID" AS "id", "TEXT" AS "text", "METADATA" AS "metadata" FROM "RAG_DOCUMENTS" WHERE "COLLECTION" = ? ORDER BY "ID" LIMIT 5',
      params: ['docs'],
    });
    assert.deepEqual(sql.scanPage('k', 5), {
      sql: 'SELECT "ID" AS "id", "TEXT" AS "text", "METADATA" AS "metadata" FROM "RAG_DOCUMENTS" WHERE "COLLECTION" = ? AND "ID" > ? ORDER BY "ID" LIMIT 5',
      params: ['docs', 'k'],
    });
  });

  it('per-collection scanPage has no collection predicate', () => {
    const sql = perCollectionStoreSql('docs', 3);
    assert.deepEqual(sql.scanPage(undefined, 5), {
      sql: 'SELECT "ID" AS "id", "TEXT" AS "text", "METADATA" AS "metadata" FROM "docs" ORDER BY "ID" LIMIT 5',
      params: [],
    });
    assert.deepEqual(sql.scanPage('k', 5), {
      sql: 'SELECT "ID" AS "id", "TEXT" AS "text", "METADATA" AS "metadata" FROM "docs" WHERE "ID" > ? ORDER BY "ID" LIMIT 5',
      params: ['k'],
    });
  });

  it('deleteByIds is scoped to the collection in shared', () => {
    const sql = sharedStoreSql('docs', 'RAG_DOCUMENTS');
    assert.deepEqual(sql.deleteByIds(['a', 'b']), {
      sql: 'DELETE FROM "RAG_DOCUMENTS" WHERE "COLLECTION" = ? AND "ID" IN (?, ?)',
      params: ['docs', 'a', 'b'],
    });
    assert.deepEqual(perCollectionStoreSql('docs', 3).deleteByIds(['a']), {
      sql: 'DELETE FROM "docs" WHERE "ID" IN (?)',
      params: ['a'],
    });
  });
});

for (const layout of ['shared', 'per-collection'] as const) {
  describe(`HanaVectorRag scan/deleteWhere (${layout})`, () => {
    it('pages by the ID key, never returns a vector, id from the ID column', async () => {
      const hana = storingHana({ dimension: DIM });
      const store = open(hana, 'kb', layout);
      for (const id of ['c', 'a', 'e', 'b', 'd']) await put(store, id);
      const first = await store.scan({ pageSize: 2 });
      assert.ok(first.ok);
      assert.deepEqual(
        first.value.records.map((r) => r.id),
        ['a', 'b'],
      );
      assert.equal(decodeIdScanCursor(first.value.cursor), 'b');
      assert.equal(first.value.records[0].metadata.id, 'a');
      assert.equal(first.value.records[0].text, 'text a');
      assert.ok(!('vector' in first.value.records[0]));
      assert.deepEqual(
        (await scanAll(store, 2)).map((r) => r.id),
        ['a', 'b', 'c', 'd', 'e'],
      );
      assert.equal(DEFAULT_SCAN_PAGE_SIZE, 500);
      assert.ok(hana.statements.some((s) => s.endsWith('LIMIT 2')));
    });

    it('takes the id from the ID column, not from the metadata JSON', async () => {
      const hana = storingHana({ dimension: DIM });
      const store = open(hana, 'kb', layout);
      const row = {
        ID: 'real',
        TEXT: 't',
        VECTOR: Array(DIM).fill(0),
        METADATA: JSON.stringify({ id: 'other', userId: 'u1' }),
      };
      if (layout === 'shared')
        hana.insertRow('RAG_DOCUMENTS', { ...row, COLLECTION: 'kb' });
      else hana.insertRow('kb', row);
      const r = await store.scan();
      assert.ok(r.ok);
      assert.equal(r.value.records[0].id, 'real');
      assert.equal(r.value.records[0].metadata.id, 'real');
    });

    it('refuses a pageSize that is not a positive integer, before any SQL', async () => {
      const hana = storingHana({ dimension: DIM });
      const store = open(hana, 'kb', layout);
      const before = hana.statements.length;
      for (const pageSize of [Number.NaN, Infinity, 0, -1, 2.5]) {
        const r = await store.scan({ pageSize });
        assert.ok(!r.ok);
        assert.equal(r.error.code, INVALID_ARGUMENT);
      }
      assert.equal(hana.statements.length, before);
    });

    it('an aborted signal is ABORTED for scan and deleteWhere', async () => {
      const hana = storingHana({ dimension: DIM });
      const store = open(hana, 'kb', layout);
      const signal = AbortSignal.abort();
      const s = await store.scan(undefined, { signal });
      assert.ok(!s.ok);
      assert.equal(s.error.code, 'ABORTED');
      const d = await store.deleteWhere({ userId: 'u1' }, { signal });
      assert.ok(!d.ok);
      assert.equal(d.error.code, 'ABORTED');
    });

    it('deleteWhere aborted between batches is ABORTED and says how many went', async () => {
      const hana = storingHana({ dimension: DIM });
      const ctl = new AbortController();
      const client = {
        ...hana.client,
        exec: async (sql: string, params?: readonly unknown[]) => {
          const r = await hana.client.exec(sql, params);
          if (sql.startsWith('DELETE')) ctl.abort();
          return r;
        },
      };
      if (layout === 'per-collection') hana.createCollectionTable('kb');
      const store = new HanaVectorRag(
        {
          collectionName: 'kb',
          dimension: DIM,
          credential: staticLogin('u', 'p'),
          layout,
          autoCreateSchema: false,
          embedder,
        },
        client,
      ) as Store;
      for (let i = 0; i < 1500; i++) {
        await put(store, `id${String(i).padStart(5, '0')}`, { userId: 'u1' });
      }
      const d = await store.deleteWhere(
        { userId: 'u1' },
        { signal: ctl.signal },
      );
      assert.ok(!d.ok);
      assert.equal(d.error.code, 'ABORTED');
      assert.match(d.error.message, /1000/);
      assert.equal((await scanAll(store)).length, 500);
    });

    it('a malformed cursor is INVALID_ARGUMENT before any SQL', async () => {
      const hana = storingHana({ dimension: DIM });
      const store = open(hana, 'kb', layout);
      await put(store, 'a');
      const before = hana.statements.length;
      // A raw id is not a cursor this store issued.
      for (const cursor of ['a', 'not a cursor!', '']) {
        const r = await store.scan({ cursor });
        assert.ok(!r.ok);
        assert.equal(r.error.code, INVALID_ARGUMENT);
      }
      assert.equal(hana.statements.length, before);
    });

    it('an ABORTED thrown inside an existing operation keeps its 30.2.0 code', async () => {
      const hana = storingHana({ dimension: DIM });
      if (layout === 'per-collection') hana.createCollectionTable('kb');
      // A signal-bound embedder (RetryEmbedder) throws exactly this.
      const aborting = symmetricEmbedder({
        embed: async () => {
          throw new RagError('Aborted', 'ABORTED');
        },
      });
      const store = new HanaVectorRag(
        {
          collectionName: 'kb',
          dimension: DIM,
          credential: staticLogin('u', 'p'),
          layout,
          autoCreateSchema: false,
          embedder: aborting,
        },
        hana.client,
      ) as Store;
      const u = await store.upsert('text', { id: 'a' });
      assert.ok(!u.ok);
      assert.equal(u.error.code, 'UPSERT_ERROR');
      const q = await store.query(new QueryEmbedding('text', aborting), 3);
      assert.ok(!q.ok);
      assert.equal(q.error.code, 'QUERY_ERROR');
    });

    it('scan and deleteWhere pass an ABORTED from the driver through', async () => {
      const hana = storingHana({ dimension: DIM });
      let abort = false;
      const client = {
        ...hana.client,
        query: async (sql: string, params?: readonly unknown[]) => {
          if (abort && sql.startsWith('SELECT "ID"'))
            throw new RagError('Aborted', 'ABORTED');
          return hana.client.query(sql, params);
        },
      };
      if (layout === 'per-collection') hana.createCollectionTable('kb');
      const store = new HanaVectorRag(
        {
          collectionName: 'kb',
          dimension: DIM,
          credential: staticLogin('u', 'p'),
          layout,
          autoCreateSchema: false,
          embedder,
        },
        client,
      ) as Store;
      await put(store, 'a', { userId: 'u1' });
      abort = true;
      const s = await store.scan();
      assert.ok(!s.ok);
      assert.equal(s.error.code, 'ABORTED');
      const d = await store.deleteWhere({ userId: 'u1' });
      assert.ok(!d.ok);
      assert.equal(d.error.code, 'ABORTED');
    });

    it('a full last page is followed by an empty one', async () => {
      const hana = storingHana({ dimension: DIM });
      const store = open(hana, 'kb', layout);
      for (const id of ['a', 'b']) await put(store, id);
      assert.deepEqual(
        (await scanAll(store, 2)).map((r) => r.id),
        ['a', 'b'],
      );
    });

    it('deleteWhere batches ids by at most 1000 and counts exactly', async () => {
      const hana = storingHana({ dimension: DIM });
      const store = open(hana, 'kb', layout);
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
        hana.statements.filter((s) => s.startsWith('DELETE')).length,
        1,
      );
      const more = await store.deleteWhere({ userId: 'u2' });
      assert.ok(more.ok);
      assert.equal(more.value.deleted, 1400);
      assert.equal(
        hana.statements.filter((s) => s.startsWith('DELETE')).length,
        3,
      );
    });

    it('deleteWhere refuses an empty filter before any SQL', async () => {
      const hana = storingHana({ dimension: DIM });
      const store = open(hana, 'kb', layout);
      const before = hana.statements.length;
      const r = await store.deleteWhere({});
      assert.ok(!r.ok);
      assert.equal(r.error.code, INVALID_ARGUMENT);
      assert.equal(hana.statements.length, before);
    });

    it('sends no DDL across the lifecycle', async () => {
      const hana = storingHana({ dimension: DIM });
      const store = open(hana, 'kb', layout);
      await put(store, 'a', { userId: 'u1' });
      await scanAll(store);
      await store.deleteWhere({ userId: 'u1' });
      for (const s of hana.statements) assert.doesNotMatch(s, DDL);
    });
  });
}

describe('HanaVectorRag scan/deleteWhere (shared check)', () => {
  it('runs the check first and returns its error unchanged', async () => {
    const hana = storingHana({ dimension: 8 });
    const store = open(hana, 'kb', 'shared', DIM);
    const s = await store.scan();
    assert.ok(!s.ok);
    assert.equal(s.error.code, 'SHARED_LAYOUT_NOT_DEPLOYED');
    const d = await store.deleteWhere({ userId: 'u1' });
    assert.ok(!d.ok);
    assert.equal(d.error.code, 'SHARED_LAYOUT_NOT_DEPLOYED');
    assert.ok(
      hana.statements.every((q) => !q.includes('"RAG_DOCUMENTS" WHERE')),
    );
  });

  it('a check that cannot run is HEALTH_CHECK_ERROR', async () => {
    const hana = storingHana({ dimension: DIM });
    const failing = {
      ...hana.client,
      query: async (): Promise<never> => {
        throw new Error('down');
      },
    };
    const store = new HanaVectorRag(
      {
        collectionName: 'kb',
        dimension: DIM,
        credential: staticLogin('u', 'p'),
        layout: 'shared',
        embedder,
      },
      failing,
    ) as Store;
    const r = await store.scan();
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'HEALTH_CHECK_ERROR');
  });
});

// The kit over the storing fake, in each layout.
for (const layout of ['shared', 'per-collection'] as const) {
  describe(`scan/delete conformance — HanaVectorRag ${layout} (storing fake)`, () => {
    const subject = async (): Promise<ScanDeleteSubject> => {
      const hana = storingHana({
        dimension: DIM,
        // The per-collection layout keeps its records in the default catalog.
        ...(layout === 'per-collection'
          ? { catalogTable: 'rag_collection_catalog' }
          : {}),
      });
      return {
        store: async () => open(hana, 'kit', layout),
        catalog: async () => {
          const provider = new HanaVectorRagProvider({
            name: 'hana',
            embedder,
            connection: {
              collectionName: '__unused',
              dimension: DIM,
              credential: staticLogin('u', 'p'),
            },
            layout,
            ...(layout === 'per-collection' ? { autoCreateSchema: false } : {}),
            clientFactory: () => hana.client,
          });
          return {
            provider,
            async create(name) {
              if (layout === 'per-collection') hana.createCollectionTable(name);
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
          ? { sibling: async () => open(hana, 'sib', layout) }
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
