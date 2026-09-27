import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IEmbedder } from '@mcp-abap-adt/llm-agent';
import { staticLogin } from '@mcp-abap-adt/llm-agent';
import {
  CONFORMANCE_EMBEDDING_DIM,
  conformanceEmbedder,
  ragFilterConformanceCases,
} from '@mcp-abap-adt/llm-agent/testing/rag-filter-conformance';
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
      {
        collectionName: 'docs',
        dimension: 3,
        embedder: makeEmbedder(3),
        credential: staticLogin('u', 'p'),
      },
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
      {
        collectionName: 'docs',
        dimension: 3,
        embedder: makeEmbedder(3),
        credential: staticLogin('u', 'p'),
      },
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
    // The id lives in its own column; a reader (tool selection's
    // toolNameFromRecord) finds it in metadata, as every other store returns it.
    assert.equal(res.value[0].metadata?.id, 'a');
  });

  it('upsertRaw issues UPSERT with vector literal', async () => {
    const client = makeFakeClient();
    const rag = new HanaVectorRag(
      {
        collectionName: 'docs',
        dimension: 3,
        embedder: makeEmbedder(3),
        credential: staticLogin('u', 'p'),
      },
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
      {
        collectionName: 'docs',
        dimension: 3,
        embedder: makeEmbedder(3),
        credential: staticLogin('u', 'p'),
      },
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
      {
        collectionName: 'docs',
        dimension: 3,
        embedder: makeEmbedder(3),
        credential: staticLogin('u', 'p'),
      },
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
      {
        collectionName: 'docs',
        dimension: 3,
        embedder: makeEmbedder(3),
        credential: staticLogin('u', 'p'),
      },
      client,
    );
    const writer = rag.writer();
    assert.ok(writer.clearAll);
    const r = await writer.clearAll();
    assert.equal(r.ok, true);
    assert.ok(client.calls.some((c) => c.sql.startsWith('TRUNCATE')));
  });

  it('healthCheck runs SELECT 1 FROM DUMMY', async () => {
    const client = makeFakeClient([{ '1': 1 }]);
    const rag = new HanaVectorRag(
      {
        collectionName: 'docs',
        dimension: 3,
        embedder: makeEmbedder(3),
        credential: staticLogin('u', 'p'),
      },
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
          {
            collectionName: "bad'; DROP",
            embedder: makeEmbedder(),
            credential: staticLogin('u', 'p'),
          },
          makeFakeClient(),
        ),
      (err: Error & { code?: string }) =>
        err.code === 'INVALID_COLLECTION_NAME',
    );
  });
});

// ---------------------------------------------------------------------------
// Session/user filter (security). No live HANA exists to test against, so the
// store filters in the client; this fake stores rows and answers the search
// SELECT like HANA would (cosine similarity, ORDER BY score DESC, optional
// LIMIT), so the conformance cases exercise the real in-code filter.
// ---------------------------------------------------------------------------

function cosineOf(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] ** 2;
    nb += b[i] ** 2;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

function parseVector(sql: string): number[] {
  const m = sql.match(/TO_REAL_VECTOR\('\[([^\]]*)\]'\)/);
  if (!m) throw new Error(`no vector literal in: ${sql}`);
  return m[1].split(',').map(Number);
}

function makeStoringHana(): HanaClient & { searches: string[] } {
  const rows = new Map<
    string,
    { id: string; text: string; vector: number[]; metadata: string }
  >();
  const searches: string[] = [];
  return {
    searches,
    async exec(sql, params = []) {
      if (sql.startsWith('UPSERT')) {
        const [id, text, metadata] = params as string[];
        rows.set(id, { id, text, metadata, vector: parseVector(sql) });
      }
      return { rowCount: 1 };
    },
    async query(sql) {
      if (!sql.startsWith('SELECT id, text, metadata, COSINE_SIMILARITY')) {
        return [];
      }
      searches.push(sql);
      const q = parseVector(sql);
      const scored = [...rows.values()]
        .map((r) => ({
          id: r.id,
          text: r.text,
          metadata: r.metadata,
          score: cosineOf(q, r.vector),
        }))
        .sort((a, b) => b.score - a.score);
      const limit = sql.match(/LIMIT (\d+)$/);
      return limit ? scored.slice(0, Number(limit[1])) : scored;
    },
    async close() {},
  };
}

describe('HanaVectorRag — session/user filter (security)', () => {
  for (const c of ragFilterConformanceCases) {
    it(`conformance: ${c.name}`, () =>
      c.run(
        async () =>
          new HanaVectorRag(
            {
              collectionName: 'docs',
              dimension: CONFORMANCE_EMBEDDING_DIM,
              embedder: conformanceEmbedder(),
              credential: staticLogin('u', 'p'),
            },
            makeStoringHana(),
          ),
      ));
  }

  it('keeps the LIMIT query when no identity filter is given, drops it when one is', async () => {
    const client = makeStoringHana();
    const rag = new HanaVectorRag(
      {
        collectionName: 'docs',
        dimension: 3,
        embedder: makeEmbedder(3),
        credential: staticLogin('u', 'p'),
      },
      client,
    );
    const emb = { text: 'q', toVector: async () => [0.1, 0.2, 0.3] };
    await rag.query(emb, 5);
    await rag.query(emb, 5, { ragFilter: { sessionId: 's1' } });
    await rag.query(emb, 5, { ragFilter: { userId: 'u1' } });
    assert.match(client.searches[0], /ORDER BY score DESC LIMIT 5$/);
    assert.match(client.searches[1], /ORDER BY score DESC$/);
    assert.match(client.searches[2], /ORDER BY score DESC$/);
    // The filter value never reaches the SQL text.
    assert.ok(!client.searches[1].includes('s1'));
  });
});
