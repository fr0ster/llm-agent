import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_SCAN_PAGE_SIZE,
  INVALID_ARGUMENT,
  type IRagFilteredDeleter,
  type IRagScanner,
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
      assert.equal(first.value.cursor, 'b');
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
      const hana = storingHana({ dimension: DIM });
      return {
        store: async () => open(hana, 'kit', layout),
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
