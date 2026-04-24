import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IEmbedder } from '@mcp-abap-adt/llm-agent';
import { type HanaClient, HanaVectorRag } from '../hana-vector-rag.js';

function makeEmbedder(dim = 3): IEmbedder {
  return {
    async embed(text: string) {
      let h = 0;
      for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) | 0;
      return {
        vector: Array.from({ length: dim }, (_, i) => ((h >> i) & 0xff) / 255),
      };
    },
  };
}

interface ExecCall {
  sql: string;
  params: readonly unknown[];
}

function makeFakeClient(
  rows: Record<string, unknown>[] = [],
): HanaClient & { calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  return {
    calls,
    async exec(sql, params = []) {
      calls.push({ sql, params });
      return { rowCount: 1 };
    },
    async query(sql, params = []) {
      calls.push({ sql, params });
      return rows;
    },
    async close() {
      /* noop */
    },
  };
}

describe('HanaVectorRag', () => {
  it('ensureSchema runs CREATE TABLE only once', async () => {
    const client = makeFakeClient();
    const rag = new HanaVectorRag(
      { collectionName: 'docs', dimension: 3, embedder: makeEmbedder(3) },
      client,
    );
    await rag.ensureSchema();
    await rag.ensureSchema();
    const creates = client.calls.filter((c) => c.sql.includes('CREATE TABLE'));
    assert.equal(creates.length, 1);
  });

  it('query returns results mapped from rows', async () => {
    const rows = [
      { id: 'a', text: 'hello', metadata: '{"namespace":"n"}', score: 0.9 },
    ];
    const client = makeFakeClient(rows);
    const rag = new HanaVectorRag(
      { collectionName: 'docs', dimension: 3, embedder: makeEmbedder(3) },
      client,
    );
    const res = await rag.query(
      { text: 'test query', toVector: async () => [0.1, 0.2, 0.3] },
      5,
    );
    assert.equal(res.ok, true);
    if (!res.ok) throw new Error('unreachable');
    assert.equal(res.value.length, 1);
    assert.equal(res.value[0].text, 'hello');
    assert.equal(res.value[0].metadata?.namespace, 'n');
  });

  it('upsertRaw issues UPSERT with vector literal', async () => {
    const client = makeFakeClient();
    const rag = new HanaVectorRag(
      { collectionName: 'docs', dimension: 3, embedder: makeEmbedder(3) },
      client,
    );
    const r = await rag.writer().upsertRaw('id1', 'text', { namespace: 'n' });
    assert.equal(r.ok, true);
    const upsert = client.calls.find((c) => c.sql.startsWith('UPSERT'));
    assert.ok(upsert, 'UPSERT should have been issued');
  });

  it('deleteByIdRaw issues DELETE', async () => {
    const client = makeFakeClient();
    const rag = new HanaVectorRag(
      { collectionName: 'docs', dimension: 3, embedder: makeEmbedder(3) },
      client,
    );
    const r = await rag.writer().deleteByIdRaw('id1');
    assert.equal(r.ok, true);
    assert.ok(client.calls.some((c) => c.sql.includes('DELETE FROM')));
  });

  it('deleteByIdRaw reports false when no row matched', async () => {
    const calls: ExecCall[] = [];
    const client: HanaClient = {
      async exec(sql, params = []) {
        calls.push({ sql, params });
        return { rowCount: 0 };
      },
      async query() {
        return [];
      },
      async close() {},
    };
    const rag = new HanaVectorRag(
      { collectionName: 'docs', dimension: 3, embedder: makeEmbedder(3) },
      client,
    );
    const r = await rag.writer().deleteByIdRaw('missing');
    assert.equal(r.ok, true);
    if (!r.ok) throw new Error('unreachable');
    assert.equal(r.value, false);
  });

  it('clearAll issues TRUNCATE', async () => {
    const client = makeFakeClient();
    const rag = new HanaVectorRag(
      { collectionName: 'docs', dimension: 3, embedder: makeEmbedder(3) },
      client,
    );
    const r = await rag.writer().clearAll!();
    assert.equal(r.ok, true);
    assert.ok(client.calls.some((c) => c.sql.startsWith('TRUNCATE')));
  });

  it('healthCheck runs SELECT 1 FROM DUMMY', async () => {
    const client = makeFakeClient([{ '1': 1 }]);
    const rag = new HanaVectorRag(
      { collectionName: 'docs', dimension: 3, embedder: makeEmbedder(3) },
      client,
    );
    const r = await rag.healthCheck();
    assert.equal(r.ok, true);
    assert.ok(client.calls.some((c) => c.sql.includes('FROM DUMMY')));
  });

  it('rejects invalid collection name at construction', () => {
    assert.throws(
      () =>
        new HanaVectorRag(
          { collectionName: "bad'; DROP", embedder: makeEmbedder() },
          makeFakeClient(),
        ),
      (err: Error & { code?: string }) =>
        err.code === 'INVALID_COLLECTION_NAME',
    );
  });
});
