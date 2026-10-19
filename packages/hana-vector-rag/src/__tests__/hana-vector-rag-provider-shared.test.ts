import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CatalogRecordDeleteError,
  DuplicateCollectionError,
  OrphanStoreError,
  staticLogin,
  symmetricEmbedder,
} from '@mcp-abap-adt/llm-agent';
import type { HanaClient } from '../hana-vector-rag.js';
import { HanaVectorRagProvider } from '../hana-vector-rag-provider.js';

type Call = { sql: string; params: readonly unknown[] };

interface Fake {
  client: HanaClient;
  calls: Call[];
  tables: Set<string>;
  records: Map<string, unknown[]>;
  docCount: Map<string, number>;
  failOn?: RegExp;
  dim: number;
  docs: string;
}

function fake(): Fake {
  const f: Fake = {
    calls: [],
    tables: new Set(['RAG_DOCUMENTS', 'RAG_COLLECTIONS']),
    records: new Map(),
    docCount: new Map(),
    dim: 3,
    docs: 'RAG_DOCUMENTS',
    client: undefined as unknown as HanaClient,
  };
  const run = (sql: string, params: readonly unknown[]) => {
    f.calls.push({ sql, params });
    if (f.failOn?.test(sql)) throw new Error('refused by the test');
    if (sql.includes('FROM SYS.TABLES'))
      return [{ n: f.tables.has(String(params[params.length - 1])) ? 1 : 0 }];
    if (sql.includes('SYS.TABLE_COLUMNS')) return [{ dim: f.dim }];
    if (sql.startsWith('SELECT 1 AS "present"'))
      return f.records.has(String(params[0])) ? [{ present: 1 }] : [];
    if (sql.startsWith(`SELECT COUNT(*) AS "n" FROM "${f.docs}" WHERE`))
      return [{ n: f.docCount.get(String(params[0])) ?? 0 }];
    if (sql.startsWith('INSERT INTO "RAG_COLLECTIONS"')) {
      if (f.records.has(String(params[0]))) throw new Error('unique');
      f.records.set(String(params[0]), [...params]);
      return [{}];
    }
    if (sql.startsWith(`DELETE FROM "${f.docs}"`)) {
      f.docCount.delete(String(params[0]));
      return [{}];
    }
    if (sql.startsWith('DELETE FROM "RAG_COLLECTIONS"')) {
      f.records.delete(String(params[0]));
      return [{}];
    }
    if (sql.startsWith('SELECT store_name AS "s"'))
      return [...f.records.keys()].map((s) => ({ s }));
    if (sql.startsWith(`SELECT DISTINCT "COLLECTION" AS "c" FROM "${f.docs}"`))
      return [...f.docCount.keys()].map((c) => ({ c }));
    if (sql.startsWith('SELECT store_name AS "storeName"'))
      return [...f.records.values()].map((p) => ({
        storeName: p[0],
        name: p[1],
        scope: p[2],
        userId: p[3],
        sessionId: p[4],
        attributesJson: p[5],
      }));
    throw new Error(`unhandled: ${sql}`);
  };
  f.client = {
    exec: async (sql, params = []) => ({ rowCount: run(sql, params).length }),
    query: async (sql, params = []) => run(sql, params),
    close: async () => {},
  };
  return f;
}

function provider(f: Fake, extra: Record<string, unknown> = {}) {
  return new HanaVectorRagProvider({
    name: 'hana',
    embedder: symmetricEmbedder({ embed: async () => ({ vector: [0, 0, 0] }) }),
    connection: {
      collectionName: '__ignored',
      host: 'h',
      credential: staticLogin('u', 'p'),
    },
    defaultDimension: 3,
    layout: 'shared',
    clientFactory: () => f.client,
    ...extra,
  });
}

const opts = { scope: 'global' as const };
const DDL = /\b(CREATE|DROP|TRUNCATE|ALTER)\b|IF NOT EXISTS/;

describe('HanaVectorRagProvider, shared layout', () => {
  it('refuses autoCreateSchema: true at construction', () => {
    assert.throws(
      () => provider(fake(), { autoCreateSchema: true }),
      (e: { code?: string }) => e.code === 'INVALID_CONFIG',
    );
  });

  it('a missing catalog makes createCollection SHARED_LAYOUT_NOT_DEPLOYED', async () => {
    const f = fake();
    f.tables.delete('RAG_COLLECTIONS');
    const r = await provider(f).createCollection('kb', opts);
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'SHARED_LAYOUT_NOT_DEPLOYED');
  });

  it('every public method runs the check first', async () => {
    const f = fake();
    f.tables.clear();
    const p = provider(f);
    for (const r of [
      await p.createCollection('kb', opts),
      await p.describeCollections(),
      await p.deleteCollection('kb'),
      await p.listCollections(),
    ]) {
      assert.ok(!r.ok);
      assert.equal(r.error.code, 'SHARED_LAYOUT_NOT_DEPLOYED');
    }
    assert.equal(f.calls.length > 0, true);
    assert.ok(f.calls.every((c) => /SYS\.TABLE/.test(c.sql)));
  });

  it('checks only once after a success, retries after a failure', async () => {
    const f = fake();
    f.tables.delete('RAG_COLLECTIONS');
    const p = provider(f);
    assert.ok(!(await p.listCollections()).ok);
    f.tables.add('RAG_COLLECTIONS');
    assert.ok((await p.listCollections()).ok);
    const n = f.calls.length;
    assert.ok((await p.listCollections()).ok);
    assert.equal(
      f.calls.slice(n).filter((c) => /SYS\.TABLE/.test(c.sql)).length,
      0,
    );
  });

  it('createCollection inserts the record, sends no DDL; a second create is a duplicate', async () => {
    const f = fake();
    const p = provider(f);
    const r = await p.createCollection('kb', opts);
    assert.ok(r.ok);
    assert.ok(
      f.calls.some((c) => c.sql.startsWith('INSERT INTO "RAG_COLLECTIONS"')),
    );
    const again = await p.createCollection('kb', opts);
    assert.ok(!again.ok);
    assert.ok(again.error instanceof DuplicateCollectionError);
  });

  it('orphan documents: OrphanStoreError, or adopted without a DELETE', async () => {
    const f = fake();
    f.docCount.set('kb', 3);
    const p = provider(f);
    const refused = await p.createCollection('kb', opts);
    assert.ok(!refused.ok);
    assert.ok(refused.error instanceof OrphanStoreError);
    assert.ok(!f.records.has('kb'));
    const adopted = await p.createCollection('kb', {
      ...opts,
      adoptExisting: true,
    });
    assert.ok(adopted.ok);
    assert.ok(f.records.has('kb'));
    assert.ok(!f.calls.some((c) => c.sql.startsWith('DELETE')));
  });

  it('deleteCollection removes documents before the record', async () => {
    const f = fake();
    const p = provider(f);
    await p.createCollection('kb', opts);
    f.calls.length = 0;
    const r = await p.deleteCollection('kb');
    assert.ok(r.ok);
    const docs = f.calls.findIndex(
      (c) => c.sql === 'DELETE FROM "RAG_DOCUMENTS" WHERE "COLLECTION" = ?',
    );
    const rec = f.calls.findIndex(
      (c) => c.sql === 'DELETE FROM "RAG_COLLECTIONS" WHERE store_name = ?',
    );
    assert.ok(docs >= 0 && rec > docs);
    assert.ok(!f.records.has('kb'));
  });

  it('a failed documents delete is RAG_DELETE_ERROR and keeps the record', async () => {
    const f = fake();
    const p = provider(f);
    await p.createCollection('kb', opts);
    f.failOn = /^DELETE FROM "RAG_DOCUMENTS"/;
    const r = await p.deleteCollection('kb');
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'RAG_DELETE_ERROR');
    assert.ok(f.records.has('kb'));
  });

  it('listCollections is the sorted union without duplicates', async () => {
    const f = fake();
    const p = provider(f);
    await p.createCollection('b', opts);
    await p.createCollection('a', opts);
    f.docCount.set('b', 1);
    f.docCount.set('c', 2);
    const r = await p.listCollections();
    assert.ok(r.ok);
    assert.deepEqual(r.value, ['a', 'b', 'c']);
  });

  it('describeCollections returns the records', async () => {
    const f = fake();
    const p = provider(f);
    await p.createCollection('kb', opts);
    const r = await p.describeCollections();
    assert.ok(r.ok);
    assert.equal(r.value.records.length, 1);
    assert.equal(r.value.records[0].storeName, 'kb');
  });

  it('the whole lifecycle sends no DDL', async () => {
    const f = fake();
    const p = provider(f);
    await p.createCollection('kb', opts);
    await p.describeCollections();
    await p.listCollections();
    await p.deleteCollection('kb');
    assert.ok(f.calls.length > 0);
    assert.ok(!f.calls.some((c) => DDL.test(c.sql)));
  });

  it('a failed record delete after the documents delete is CatalogRecordDeleteError', async () => {
    const f = fake();
    const p = provider(f);
    await p.createCollection('kb', opts);
    f.failOn = /^DELETE FROM "RAG_COLLECTIONS"/;
    const r = await p.deleteCollection('kb');
    assert.ok(!r.ok);
    assert.ok(r.error instanceof CatalogRecordDeleteError);
    assert.ok(
      f.calls.some((c) => c.sql.startsWith('DELETE FROM "RAG_DOCUMENTS"')),
    );
  });

  it('delete and list use a custom documentsTable', async () => {
    const f = fake();
    f.docs = 'MY_DOCS';
    f.tables.add('MY_DOCS');
    f.tables.delete('RAG_DOCUMENTS');
    const p = provider(f, { documentsTable: 'MY_DOCS' });
    await p.createCollection('kb', opts);
    f.docCount.set('kb', 2);
    f.docCount.set('other', 1);
    const listed = await p.listCollections();
    assert.ok(listed.ok);
    assert.deepEqual(listed.value, ['kb', 'other']);
    const r = await p.deleteCollection('kb');
    assert.ok(r.ok);
    assert.ok(
      f.calls.some(
        (c) => c.sql === 'DELETE FROM "MY_DOCS" WHERE "COLLECTION" = ?',
      ),
    );
    assert.ok(!f.docCount.has('kb'));
  });
});
