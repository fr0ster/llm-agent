import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CatalogRecordDeleteError,
  DuplicateCollectionError,
  OrphanStoreError,
  symmetricEmbedder,
} from '@mcp-abap-adt/llm-agent';
import type { PgClient } from '../pg-vector-rag.js';
import { PgVectorRagProvider } from '../pg-vector-rag-provider.js';

type Call = { sql: string; params: readonly unknown[] };
type Rows = Array<Record<string, unknown>>;

interface Fake {
  client: PgClient;
  calls: Call[];
  /** Qualified names as the check passes them, e.g. `"rag_documents"` or `"s"."rag_documents"`. */
  tables: Set<string>;
  records: Map<string, unknown[]>;
  docCount: Map<string, number>;
  failOn?: RegExp;
  /** Runs inside the catalog INSERT, before it fails — another writer racing. */
  beforeInsert?: () => void;
  dim: number;
  /** The configured documents table, quoted and qualified as the provider sends it. */
  docs: string;
  catalog: string;
}

/** A recording fake that honours the configured schema and tables. */
function fake(schema?: string, docsName = 'rag_documents'): Fake {
  const q = (t: string) => (schema ? `"${schema}"."${t}"` : `"${t}"`);
  const f: Fake = {
    calls: [],
    tables: new Set([q(docsName), q('rag_collections')]),
    records: new Map(),
    docCount: new Map(),
    dim: 3,
    docs: q(docsName),
    catalog: q('rag_collections'),
    client: undefined as unknown as PgClient,
  };
  const run = (sql: string, params: readonly unknown[]): Rows => {
    f.calls.push({ sql, params });
    if (f.failOn?.test(sql)) throw new Error('refused by the test');
    if (sql.startsWith('SELECT to_regclass'))
      return [{ present: f.tables.has(String(params[0])) }];
    if (sql.includes('FROM pg_attribute'))
      return params[0] === f.docs && f.tables.has(f.docs)
        ? [{ dim: f.dim }]
        : [];
    if (sql.startsWith(`SELECT 1 AS present FROM ${f.catalog} WHERE`))
      return f.records.has(String(params[0])) ? [{ present: 1 }] : [];
    if (sql.startsWith(`SELECT COUNT(*) AS n FROM ${f.docs} WHERE`))
      return [{ n: f.docCount.get(String(params[0])) ?? 0 }];
    if (sql.startsWith(`INSERT INTO ${f.catalog} `)) {
      f.beforeInsert?.();
      if (f.records.has(String(params[0]))) throw new Error('unique');
      f.records.set(String(params[0]), [...params]);
      return [];
    }
    if (sql.startsWith(`DELETE FROM ${f.docs} `)) {
      f.docCount.delete(String(params[0]));
      return [];
    }
    if (sql.startsWith(`DELETE FROM ${f.catalog} `)) {
      f.records.delete(String(params[0]));
      return [];
    }
    if (sql === `SELECT store_name AS "s" FROM ${f.catalog}`)
      return [...f.records.keys()].map((s) => ({ s }));
    if (sql === `SELECT DISTINCT "collection" AS "c" FROM ${f.docs}`)
      return [...f.docCount.keys()].map((c) => ({ c }));
    if (sql.startsWith('SELECT store_name AS "storeName"')) {
      assert.ok(sql.includes(`FROM ${f.catalog} `));
      return [...f.records.values()].map((p) => ({
        storeName: p[0],
        name: p[1],
        scope: p[2],
        userId: p[3],
        sessionId: p[4],
        attributesJson: p[5],
      }));
    }
    throw new Error(`unhandled: ${sql}`);
  };
  f.client = {
    query: async (sql, params = []) => {
      const rows = run(sql, params);
      return { rows, rowCount: rows.length };
    },
    end: async () => {},
  };
  return f;
}

function provider(f: Fake, extra: Record<string, unknown> = {}) {
  return new PgVectorRagProvider({
    name: 'pg',
    embedder: symmetricEmbedder({ embed: async () => ({ vector: [0, 0, 0] }) }),
    connection: { collectionName: '__ignored' },
    defaultDimension: 3,
    layout: 'shared',
    clientFactory: () => f.client,
    ...extra,
  });
}

const opts = { scope: 'global' as const };
const DDL = /^\s*(CREATE|DROP|TRUNCATE|ALTER)\b|IF NOT EXISTS/i;

for (const variant of [
  { label: 'unqualified', schema: undefined, docsName: 'rag_documents' },
  { label: 'schema "app"', schema: 'app', docsName: 'rag_documents' },
  { label: 'custom documentsTable', schema: undefined, docsName: 'my_docs' },
  { label: 'schema and custom table', schema: 'app', docsName: 'my_docs' },
]) {
  describe(`PgVectorRagProvider, shared layout (${variant.label})`, () => {
    const make = () => {
      const f = fake(variant.schema, variant.docsName);
      const extra: Record<string, unknown> = {};
      if (variant.schema)
        extra.connection = { collectionName: 'x', schema: variant.schema };
      if (variant.docsName !== 'rag_documents')
        extra.documentsTable = variant.docsName;
      return { f, p: provider(f, extra) };
    };

    it('createCollection inserts the record, sends no DDL; a second create is a duplicate', async () => {
      const { f, p } = make();
      const r = await p.createCollection('kb', opts);
      assert.ok(r.ok);
      assert.ok(
        f.calls.some((c) => c.sql.startsWith(`INSERT INTO ${f.catalog} `)),
      );
      const again = await p.createCollection('kb', opts);
      assert.ok(!again.ok);
      assert.ok(again.error instanceof DuplicateCollectionError);
    });

    it('orphan documents: OrphanStoreError, or adopted without a DELETE', async () => {
      const { f, p } = make();
      f.docCount.set('kb', 3);
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

    it('adoptExisting with no rows and no record creates the record', async () => {
      const { f, p } = make();
      const r = await p.createCollection('kb', {
        ...opts,
        adoptExisting: true,
      });
      assert.ok(r.ok);
      assert.ok(f.records.has('kb'));
    });

    it('a failed insert is RAG_CREATE_ERROR', async () => {
      const { f, p } = make();
      f.failOn = /^INSERT INTO/;
      const r = await p.createCollection('kb', opts);
      assert.ok(!r.ok);
      assert.equal(r.error.code, 'RAG_CREATE_ERROR');
    });

    it('a failed insert that finds the record present is a DuplicateCollectionError', async () => {
      const { f, p } = make();
      f.beforeInsert = () => {
        f.records.set('kb', ['kb']);
        throw new Error('unique');
      };
      const r = await p.createCollection('kb', opts);
      assert.ok(!r.ok);
      assert.ok(r.error instanceof DuplicateCollectionError);
    });

    it('deleteCollection removes documents before the record', async () => {
      const { f, p } = make();
      await p.createCollection('kb', opts);
      f.docCount.set('kb', 2);
      f.calls.length = 0;
      const r = await p.deleteCollection('kb');
      assert.ok(r.ok);
      const docs = f.calls.findIndex(
        (c) => c.sql === `DELETE FROM ${f.docs} WHERE "collection" = $1`,
      );
      const rec = f.calls.findIndex(
        (c) => c.sql === `DELETE FROM ${f.catalog} WHERE store_name = $1`,
      );
      assert.ok(docs >= 0 && rec > docs);
      assert.ok(!f.records.has('kb'));
      assert.ok(!f.docCount.has('kb'));
    });

    it('a failed documents delete is RAG_DELETE_ERROR and keeps the record', async () => {
      const { f, p } = make();
      await p.createCollection('kb', opts);
      f.failOn = /^DELETE FROM .*"collection"/;
      const r = await p.deleteCollection('kb');
      assert.ok(!r.ok);
      assert.equal(r.error.code, 'RAG_DELETE_ERROR');
      assert.ok(f.records.has('kb'));
    });

    it('a failed record delete after the documents delete is CatalogRecordDeleteError', async () => {
      const { f, p } = make();
      await p.createCollection('kb', opts);
      f.failOn = /^DELETE FROM .*store_name/;
      const r = await p.deleteCollection('kb');
      assert.ok(!r.ok);
      assert.ok(r.error instanceof CatalogRecordDeleteError);
      assert.ok(
        f.calls.some((c) => c.sql.startsWith(`DELETE FROM ${f.docs} `)),
      );
    });

    it('listCollections is the sorted union without duplicates', async () => {
      const { f, p } = make();
      await p.createCollection('b', opts);
      await p.createCollection('a', opts);
      f.docCount.set('b', 1);
      f.docCount.set('c', 2);
      const r = await p.listCollections();
      assert.ok(r.ok);
      assert.deepEqual(r.value, ['a', 'b', 'c']);
    });

    it('describeCollections runs the check, then returns the records', async () => {
      const { f, p } = make();
      const q = await p.describeCollections();
      assert.ok(q.ok);
      assert.ok(f.calls.some((c) => c.sql.startsWith('SELECT to_regclass')));
      await p.createCollection('kb', opts);
      const r = await p.describeCollections();
      assert.ok(r.ok);
      assert.equal(r.value.records.length, 1);
      assert.equal(r.value.records[0].storeName, 'kb');
    });

    it('the whole lifecycle sends no DDL', async () => {
      const { f, p } = make();
      await p.createCollection('kb', opts);
      await p.describeCollections();
      await p.listCollections();
      await p.deleteCollection('kb');
      assert.ok(f.calls.length > 0);
      assert.ok(!f.calls.some((c) => DDL.test(c.sql)));
    });

    it('every data statement names the configured tables', async () => {
      const { f, p } = make();
      await p.createCollection('kb', opts);
      f.docCount.set('kb', 1);
      await p.listCollections();
      await p.deleteCollection('kb');
      const data = f.calls.filter(
        (c) => /\b(FROM|INTO)\b/.test(c.sql) && !c.sql.includes('pg_attribute'),
      );
      assert.ok(data.length > 0);
      for (const c of data)
        assert.ok(c.sql.includes(f.docs) || c.sql.includes(f.catalog), c.sql);
    });
  });
}

describe('PgVectorRagProvider, shared layout (construction and check)', () => {
  it('refuses autoCreateSchema: true at construction', () => {
    assert.throws(
      () => provider(fake(), { autoCreateSchema: true }),
      (e: { code?: string }) => e.code === 'INVALID_CONFIG',
    );
  });

  it('a missing catalog makes createCollection SHARED_LAYOUT_NOT_DEPLOYED', async () => {
    const f = fake();
    f.tables.delete('"rag_collections"');
    const r = await provider(f).createCollection('kb', opts);
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'SHARED_LAYOUT_NOT_DEPLOYED');
  });

  it('every public method runs the check first and returns its failure unchanged', async () => {
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
    assert.ok(f.calls.length > 0);
    assert.ok(f.calls.every((c) => c.sql.startsWith('SELECT to_regclass')));
  });

  it('a check that cannot run is HEALTH_CHECK_ERROR', async () => {
    const f = fake();
    f.failOn = /to_regclass/;
    const r = await provider(f).listCollections();
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'HEALTH_CHECK_ERROR');
  });

  it('a dimension mismatch is SHARED_LAYOUT_NOT_DEPLOYED', async () => {
    const f = fake();
    f.dim = 8;
    const r = await provider(f).listCollections();
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'SHARED_LAYOUT_NOT_DEPLOYED');
  });

  it('checks only once after a success, retries after a failure', async () => {
    const f = fake();
    f.tables.delete('"rag_collections"');
    const p = provider(f);
    assert.ok(!(await p.listCollections()).ok);
    f.tables.add('"rag_collections"');
    assert.ok((await p.listCollections()).ok);
    const n = f.calls.length;
    assert.ok((await p.listCollections()).ok);
    assert.equal(
      f.calls.slice(n).filter((c) => /to_regclass|pg_attribute/.test(c.sql))
        .length,
      0,
    );
  });

  it('openCollection sends no statement', async () => {
    const f = fake();
    const r = await provider(f).openCollection({
      storeName: 'kb',
      name: 'kb',
      scope: 'global',
    });
    assert.ok(r.ok);
    assert.equal(f.calls.length, 0);
  });
});
