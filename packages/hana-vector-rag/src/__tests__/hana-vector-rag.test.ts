import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IEmbedder } from '@mcp-abap-adt/llm-agent';
import { staticLogin, symmetricEmbedder } from '@mcp-abap-adt/llm-agent';
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
  it('search SELECT quotes every alias', async () => {
    const client = makeFakeClient();
    const rag = new HanaVectorRag(
      {
        collectionName: 'docs',
        dimension: 3,
        embedder: symmetricEmbedder(makeEmbedder()),
        credential: staticLogin('u', 'p'),
      },
      client,
    );
    const result = await rag.query(
      { text: 'query', toVector: async () => [0.1, 0.2, 0.3] },
      5,
    );
    assert.equal(result.ok, true);
    const select = client.calls.find((c) => c.sql.startsWith('SELECT'));
    assert.ok(select);
    for (const alias of ['id', 'text', 'metadata', 'score']) {
      assert.ok(select.sql.includes(`AS "${alias}"`));
    }
    assert.ok(select.sql.includes('ORDER BY "score" DESC'));
    assert.ok(!select.sql.includes('AS score'));
  });

  it('getById SELECT quotes every alias', async () => {
    const client = makeFakeClient();
    const rag = new HanaVectorRag(
      {
        collectionName: 'docs',
        dimension: 3,
        embedder: symmetricEmbedder(makeEmbedder()),
        credential: staticLogin('u', 'p'),
      },
      client,
    );
    const result = await rag.getById('a');
    assert.equal(result.ok, true);
    const select = client.calls.find((c) => c.sql.startsWith('SELECT'));
    assert.ok(select);
    for (const alias of ['id', 'text', 'metadata']) {
      assert.ok(select.sql.includes(`AS "${alias}"`));
    }
  });

  it('NCLOB values that arrive as Buffer are decoded', async () => {
    const client = makeFakeClient([
      {
        id: 'a',
        text: Buffer.from('hello'),
        metadata: Buffer.from('{"k":1}'),
        score: 0.9,
      },
    ]);
    const rag = new HanaVectorRag(
      {
        collectionName: 'docs',
        dimension: 3,
        embedder: symmetricEmbedder(makeEmbedder()),
        credential: staticLogin('u', 'p'),
      },
      client,
    );
    const search = await rag.query(
      { text: 'query', toVector: async () => [0.1, 0.2, 0.3] },
      5,
    );
    assert.ok(search.ok);
    const lookup = await rag.getById('a');
    assert.ok(lookup.ok);
    assert.ok(lookup.value);
    for (const result of [search.value[0], lookup.value]) {
      assert.equal(result.text, 'hello');
      assert.equal(result.metadata.k, 1);
      assert.equal(result.metadata.id, 'a');
    }
  });

  it('ensureSchema runs CREATE TABLE only once', async () => {
    const client = makeFakeClient();
    const rag = new HanaVectorRag(
      {
        collectionName: 'docs',
        dimension: 3,
        embedder: symmetricEmbedder(makeEmbedder(3)),
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
        embedder: symmetricEmbedder(makeEmbedder(3)),
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
        embedder: symmetricEmbedder(makeEmbedder(3)),
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
        embedder: symmetricEmbedder(makeEmbedder(3)),
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
        embedder: symmetricEmbedder(makeEmbedder(3)),
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
        embedder: symmetricEmbedder(makeEmbedder(3)),
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
        embedder: symmetricEmbedder(makeEmbedder(3)),
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
            embedder: symmetricEmbedder(makeEmbedder()),
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
      if (
        !sql.startsWith(
          'SELECT id AS "id", text AS "text", metadata AS "metadata", COSINE_SIMILARITY',
        )
      ) {
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
              embedder: symmetricEmbedder(conformanceEmbedder()),
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
        embedder: symmetricEmbedder(makeEmbedder(3)),
        credential: staticLogin('u', 'p'),
      },
      client,
    );
    const emb = { text: 'q', toVector: async () => [0.1, 0.2, 0.3] };
    await rag.query(emb, 5);
    await rag.query(emb, 5, { ragFilter: { sessionId: 's1' } });
    await rag.query(emb, 5, { ragFilter: { userId: 'u1' } });
    assert.match(client.searches[0], /ORDER BY "score" DESC LIMIT 5$/);
    assert.match(client.searches[1], /ORDER BY "score" DESC$/);
    assert.match(client.searches[2], /ORDER BY "score" DESC$/);
    // The filter value never reaches the SQL text.
    assert.ok(!client.searches[1].includes('s1'));
  });

  it('drops the LIMIT for a namespace filter too, never putting it in the SQL', async () => {
    const client = makeStoringHana();
    const rag = new HanaVectorRag(
      {
        collectionName: 'docs',
        dimension: 3,
        embedder: symmetricEmbedder(makeEmbedder(3)),
        credential: staticLogin('u', 'p'),
      },
      client,
    );
    const emb = { text: 'q', toVector: async () => [0.1, 0.2, 0.3] };
    await rag.query(emb, 5, { ragFilter: { namespace: 'ns-secret' } });
    assert.match(client.searches[0], /ORDER BY "score" DESC$/);
    assert.ok(!client.searches[0].includes('ns-secret'));
  });

  it('an unscoped query re-runs without LIMIT only when expiry emptied part of a full page', async () => {
    const client = makeStoringHana();
    const rag = new HanaVectorRag(
      {
        collectionName: 'docs',
        dimension: CONFORMANCE_EMBEDDING_DIM,
        embedder: symmetricEmbedder(conformanceEmbedder()),
        credential: staticLogin('u', 'p'),
      },
      client,
    );
    const w = rag.writer();
    const now = Math.floor(Date.now() / 1000);
    await w.upsertRaw('old', 'alpha beta gamma', { ttl: now - 60 });
    await w.upsertRaw('new', 'delta epsilon', {});
    const q = async (text: string) => {
      const vector = (await conformanceEmbedder().embed(text)).vector;
      const r = await rag.query({ text, toVector: async () => vector }, 1);
      if (!r.ok) throw r.error;
      return r.value.map((x) => x.metadata.id);
    };
    // Top-1 by similarity is the expired record: the full page is emptied,
    // so the store falls back to the unlimited query and finds 'new'.
    assert.deepEqual(await q('alpha beta gamma'), ['new']);
    assert.match(client.searches[0], /LIMIT 1$/);
    assert.match(client.searches[1], /ORDER BY "score" DESC$/);
    // Top-1 is live: one LIMIT query, no fallback.
    const before = client.searches.length;
    assert.deepEqual(await q('delta epsilon'), ['new']);
    assert.equal(client.searches.length, before + 1);
    assert.match(client.searches[before], /LIMIT 1$/);
  });
});

describe('HanaVectorRag shared layout and vector validation', () => {
  function recordingClient(
    opts: { dim?: number; failFirstCheck?: boolean } = {},
  ) {
    const calls: ExecCall[] = [];
    let checkRounds = 0;
    let failed = false;
    const client: HanaClient & { calls: ExecCall[]; rounds: () => number } = {
      calls,
      rounds: () => checkRounds,
      async exec(sql, params = []) {
        calls.push({ sql, params });
        return { rowCount: 1 };
      },
      async query(sql, params = []) {
        calls.push({ sql, params });
        if (sql.includes('SYS.TABLES')) {
          checkRounds++;
          if (opts.failFirstCheck && !failed) {
            failed = true;
            throw new Error('connection reset');
          }
          return [{ n: 1 }];
        }
        if (sql.includes('SYS.TABLE_COLUMNS')) return [{ dim: opts.dim ?? 3 }];
        return [];
      },
      async close() {},
    };
    return client;
  }
  const mk = (
    client: HanaClient,
    extra: Partial<ConstructorParameters<typeof HanaVectorRag>[0]> = {},
  ) =>
    new HanaVectorRag(
      {
        collectionName: 'docs',
        dimension: 3,
        layout: 'shared',
        embedder: symmetricEmbedder(makeEmbedder(3)),
        credential: staticLogin('u', 'p'),
        ...extra,
      },
      client,
    );
  const plain = (client: HanaClient) =>
    new HanaVectorRag(
      {
        collectionName: 'docs',
        dimension: 3,
        autoCreateSchema: false,
        embedder: symmetricEmbedder(makeEmbedder(3)),
        credential: staticLogin('u', 'p'),
      },
      client,
    );

  it('shared store sends no DDL', async () => {
    const client = recordingClient();
    const rag = mk(client);
    assert.ok((await rag.upsert('t', { id: 'a' })).ok);
    assert.ok(
      (await rag.query({ text: 'q', toVector: async () => [1, 2, 3] }, 3)).ok,
    );
    assert.ok((await rag.getById('a')).ok);
    const w = rag.writer();
    assert.ok((await w.deleteByIdRaw?.('a'))?.ok);
    assert.ok((await w.clearAll?.())?.ok);
    assert.ok((await rag.healthCheck()).ok);
    assert.ok(client.calls.length > 0);
    for (const c of client.calls)
      assert.doesNotMatch(c.sql, /^\s*(CREATE|DROP|TRUNCATE|ALTER)\b/i);
  });

  it('layout shared + autoCreateSchema true throws at construction', () => {
    assert.throws(
      () => mk(recordingClient(), { autoCreateSchema: true }),
      (err: Error & { code?: string }) => err.code === 'INVALID_CONFIG',
    );
  });

  it('the shared check runs once and a success is memoised', async () => {
    const client = recordingClient();
    const rag = mk(client);
    await rag.getById('a');
    await rag.getById('b');
    assert.equal(client.rounds(), 1);
  });

  it('a failed shared check is not memoised', async () => {
    const client = recordingClient({ failFirstCheck: true });
    const rag = mk(client);
    assert.ok(!(await rag.getById('a')).ok);
    assert.ok((await rag.getById('a')).ok);
  });

  it('a dimension mismatch in the database fails the operation', async () => {
    const rag = mk(recordingClient({ dim: 768 }));
    const r = await rag.getById('a');
    assert.ok(!r.ok);
    assert.match(r.error.message, /768/);
  });

  it('a vector of the wrong length is refused before SQL', async () => {
    const client = makeFakeClient();
    const rag = plain(client);
    const up = await rag.upsertPrecomputed('t', [1, 2], { id: 'a' });
    assert.ok(!up.ok);
    assert.match(up.error.message, /2/);
    assert.match(up.error.message, /3/);
    const q = await rag.query(
      { text: 'q', toVector: async () => [1, 2, 3, 4] },
      1,
    );
    assert.ok(!q.ok);
    assert.equal(client.calls.length, 0);
  });

  it('a non-finite component is refused before SQL', async () => {
    const client = makeFakeClient();
    const rag = plain(client);
    const up = await rag.upsertPrecomputed('t', [1, Number.NaN, 3], {
      id: 'a',
    });
    assert.ok(!up.ok);
    assert.match(up.error.message, /index 1/);
    const q = await rag.query(
      { text: 'q', toVector: async () => [1, Number.POSITIVE_INFINITY, 3] },
      1,
    );
    assert.ok(!q.ok);
    assert.equal(client.calls.length, 0);
  });
});
