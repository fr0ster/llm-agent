import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IEmbedder } from '@mcp-abap-adt/llm-agent';
import { symmetricEmbedder } from '@mcp-abap-adt/llm-agent';
import { type PgClient, PgVectorRag } from '../pg-vector-rag.js';

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
): PgClient & { calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      return { rows, rowCount: rows.length };
    },
    async end() {},
  };
}

describe('PgVectorRag', () => {
  it('ensureSchema runs CREATE EXTENSION + CREATE TABLE once', async () => {
    const client = makeFakeClient();
    const rag = new PgVectorRag(
      {
        collectionName: 'docs',
        dimension: 3,
        embedder: symmetricEmbedder(makeEmbedder(3)),
      },
      client,
    );
    await rag.ensureSchema();
    await rag.ensureSchema();
    const extCount = client.calls.filter((c) =>
      c.sql.includes('CREATE EXTENSION'),
    ).length;
    const tblCount = client.calls.filter((c) =>
      c.sql.includes('CREATE TABLE'),
    ).length;
    assert.equal(extCount, 1);
    assert.equal(tblCount, 1);
  });

  it('query uses pgvector <=> distance and maps rows', async () => {
    const rows = [
      { id: 'a', text: 'hello', metadata: { namespace: 'n' }, score: 0.1 },
    ];
    const client = makeFakeClient(rows);
    const rag = new PgVectorRag(
      {
        collectionName: 'docs',
        dimension: 3,
        embedder: symmetricEmbedder(makeEmbedder(3)),
      },
      client,
    );
    const r = await rag.query(
      { text: 'test query', toVector: async () => [0.1, 0.2, 0.3] },
      5,
    );
    assert.equal(r.ok, true);
    if (!r.ok) throw new Error('unreachable');
    assert.equal(r.value[0].text, 'hello');
    assert.equal(r.value[0].metadata?.namespace, 'n');
    // The id lives in its own column; a reader (tool selection's
    // toolNameFromRecord) finds it in metadata, as every other store returns it.
    assert.equal(r.value[0].metadata?.id, 'a');
    assert.ok(client.calls.some((c) => c.sql.includes('<=>')));
  });

  it('upsertRaw issues INSERT … ON CONFLICT', async () => {
    const client = makeFakeClient();
    const rag = new PgVectorRag(
      {
        collectionName: 'docs',
        dimension: 3,
        embedder: symmetricEmbedder(makeEmbedder(3)),
      },
      client,
    );
    const r = await rag.writer().upsertRaw('id1', 'text', { namespace: 'n' });
    assert.equal(r.ok, true);
    assert.ok(client.calls.some((c) => c.sql.includes('ON CONFLICT')));
  });

  it('deleteByIdRaw issues DELETE', async () => {
    const client = makeFakeClient([{ '?column?': 1 }]);
    const rag = new PgVectorRag(
      {
        collectionName: 'docs',
        dimension: 3,
        embedder: symmetricEmbedder(makeEmbedder(3)),
      },
      client,
    );
    const r = await rag.writer().deleteByIdRaw('id1');
    assert.equal(r.ok, true);
    assert.ok(client.calls.some((c) => c.sql.startsWith('DELETE FROM')));
  });

  it('clearAll issues TRUNCATE', async () => {
    const client = makeFakeClient();
    const rag = new PgVectorRag(
      {
        collectionName: 'docs',
        dimension: 3,
        embedder: symmetricEmbedder(makeEmbedder(3)),
      },
      client,
    );
    const writer = rag.writer();
    assert.ok(writer.clearAll);
    const r = await writer.clearAll();
    assert.equal(r.ok, true);
    assert.ok(client.calls.some((c) => c.sql.startsWith('TRUNCATE')));
  });

  it('healthCheck runs SELECT 1', async () => {
    const client = makeFakeClient([{ '?column?': 1 }]);
    const rag = new PgVectorRag(
      {
        collectionName: 'docs',
        dimension: 3,
        embedder: symmetricEmbedder(makeEmbedder(3)),
      },
      client,
    );
    const r = await rag.healthCheck();
    assert.equal(r.ok, true);
    assert.ok(client.calls.some((c) => c.sql === 'SELECT 1'));
  });

  it('rejects invalid collection name', () => {
    assert.throws(
      () =>
        new PgVectorRag(
          {
            collectionName: "bad'; DROP",
            embedder: symmetricEmbedder(makeEmbedder()),
          },
          makeFakeClient(),
        ),
      (err: Error & { code?: string }) =>
        err.code === 'INVALID_COLLECTION_NAME',
    );
  });
});

describe('PgVectorRag — session/user filter (security)', () => {
  function makeRag() {
    const client = makeFakeClient();
    const rag = new PgVectorRag(
      {
        collectionName: 'docs',
        dimension: 3,
        embedder: symmetricEmbedder(makeEmbedder(3)),
      },
      client,
    );
    const lastSelect = () => {
      const c = [...client.calls]
        .reverse()
        .find((x) => x.sql.startsWith('SELECT id, text, metadata, vector'));
      if (!c) throw new Error('no search SELECT issued');
      return c;
    };
    return { rag, lastSelect };
  }
  const emb = { text: 'q', toVector: async () => [0.1, 0.2, 0.3] };

  it('sessionId and userId become parameterised WHERE conditions before ORDER BY … LIMIT', async () => {
    const { rag, lastSelect } = makeRag();
    const r = await rag.query(emb, 4, {
      ragFilter: { sessionId: 's1', userId: 'u1' },
    });
    assert.equal(r.ok, true);
    const { sql, params } = lastSelect();
    assert.match(
      sql,
      /WHERE metadata->>'sessionId' = \$1 AND metadata->>'userId' = \$2 AND COALESCE\(.*\) >= \$3 ORDER BY vector <=> .* LIMIT 4$/,
    );
    assert.deepEqual(params.slice(0, 2), ['s1', 'u1']);
  });

  it('userId alone is filtered on its own parameter', async () => {
    const { rag, lastSelect } = makeRag();
    await rag.query(emb, 2, { ragFilter: { userId: 'u1' } });
    const { sql, params } = lastSelect();
    assert.match(sql, /WHERE metadata->>'userId' = \$1 AND COALESCE/);
    assert.ok(!sql.includes("'sessionId'"));
    assert.equal(params[0], 'u1');
    assert.equal(params.length, 2);
  });

  it('no filter at all still drops expired rows, and nothing else', async () => {
    const { rag, lastSelect } = makeRag();
    const before = Date.now() / 1000;
    await rag.query(emb, 2);
    const { sql, params } = lastSelect();
    assert.match(
      sql,
      /WHERE COALESCE\(CASE WHEN jsonb_typeof\(metadata->'ttl'\) = 'number' THEN \(metadata->>'ttl'\)::float8 END, 'infinity'::float8\) >= \$1 ORDER BY/,
    );
    assert.equal(params.length, 1);
    assert.ok(Number(params[0]) >= before - 1);
  });

  it('ragFilter.namespace is a parameterised condition before LIMIT', async () => {
    const { rag, lastSelect } = makeRag();
    await rag.query(emb, 3, { ragFilter: { namespace: "n' OR '1'='1" } });
    const { sql, params } = lastSelect();
    assert.match(
      sql,
      /WHERE metadata->>'namespace' = \$1 AND COALESCE\(.*\) >= \$2 ORDER BY vector <=> .* LIMIT 3$/,
    );
    assert.ok(!sql.includes("n' OR"));
    assert.equal(params[0], "n' OR '1'='1");
  });

  it('a hostile filter value is never interpolated into the SQL', async () => {
    const { rag, lastSelect } = makeRag();
    const hostile = "s1' OR '1'='1";
    await rag.query(emb, 2, { ragFilter: { sessionId: hostile } });
    const { sql, params } = lastSelect();
    assert.ok(!sql.includes(hostile));
    assert.equal(params[0], hostile);
  });
});

describe('PgVectorRag shared layout and vector validation', () => {
  function recordingClient(
    opts: { dim?: number; failFirstCheck?: boolean } = {},
  ) {
    const calls: ExecCall[] = [];
    let checkRounds = 0;
    let failed = false;
    const client: PgClient & { calls: ExecCall[]; rounds: () => number } = {
      calls,
      rounds: () => checkRounds,
      async query(sql, params = []) {
        calls.push({ sql, params });
        if (sql.includes('pg_attribute'))
          return { rows: [{ dim: opts.dim ?? 3 }], rowCount: 1 };
        if (sql.startsWith('SELECT to_regclass')) {
          checkRounds++;
          if (opts.failFirstCheck && !failed) {
            failed = true;
            throw new Error('connection reset');
          }
          return { rows: [{ present: true }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      },
      async end() {},
    };
    return client;
  }
  const mk = (
    client: PgClient,
    extra: Partial<ConstructorParameters<typeof PgVectorRag>[0]> = {},
  ) =>
    new PgVectorRag(
      {
        collectionName: 'docs',
        dimension: 3,
        layout: 'shared',
        embedder: symmetricEmbedder(makeEmbedder(3)),
        ...extra,
      },
      client,
    );
  const plain = (client: PgClient) =>
    new PgVectorRag(
      {
        collectionName: 'docs',
        dimension: 3,
        autoCreateSchema: false,
        embedder: symmetricEmbedder(makeEmbedder(3)),
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
      assert.doesNotMatch(
        c.sql,
        /^\s*(CREATE|DROP|TRUNCATE|ALTER)\b|\bIF NOT EXISTS\b/i,
      );
  });

  it('an unknown layout throws INVALID_CONFIG naming the allowed values', () => {
    assert.throws(
      // biome-ignore lint/suspicious/noExplicitAny: deliberately wrong value
      () => mk(recordingClient(), { layout: 'Shared' as any }),
      (err: Error & { code?: string }) =>
        err.code === 'INVALID_CONFIG' &&
        /per-collection.*shared/.test(err.message),
    );
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
    const first = await rag.getById('a');
    assert.ok(!first.ok);
    assert.equal(first.error.code, 'HEALTH_CHECK_ERROR');
    assert.ok((await rag.getById('a')).ok);
  });

  it('check and data statements resolve the same table, qualified by schema', async () => {
    for (const [schema, name] of [
      ['kb', '"kb"."rag_documents"'],
      [undefined, '"rag_documents"'],
    ] as const) {
      const client = recordingClient();
      const rag = mk(client, { schema });
      await rag.upsertPrecomputed('t', [1, 2, 3], { id: 'a' });
      await rag.query({ text: 'q', toVector: async () => [1, 2, 3] }, 1);
      await rag.writer().clearAll?.();
      const check = client.calls.filter((c) => c.sql.includes('to_regclass'));
      assert.ok(check.length > 0);
      for (const c of check) assert.equal(c.params[0], name);
      for (const re of [/^INSERT INTO /, /^SELECT "id"/, /^DELETE FROM /]) {
        const stmt = client.calls.find((c) => re.test(c.sql));
        assert.ok(stmt, String(re));
        assert.ok(stmt.sql.includes(` ${name} `), stmt.sql);
      }
    }
  });

  it('a dimension mismatch in the database fails the operation', async () => {
    const rag = mk(recordingClient({ dim: 768 }));
    const r = await rag.getById('a');
    assert.ok(!r.ok);
    assert.match(r.error.message, /768/);
  });

  const isData = (c: ExecCall) => /^\s*(SELECT "id"|INSERT INTO)/.test(c.sql);

  it('a vector of the wrong length is refused before SQL', async () => {
    const client = recordingClient();
    const rag = mk(client);
    const up = await rag.upsertPrecomputed('t', [1, 2], { id: 'a' });
    assert.ok(!up.ok);
    assert.match(up.error.message, /2/);
    assert.match(up.error.message, /3/);
    const q = await rag.query(
      { text: 'q', toVector: async () => [1, 2, 3, 4] },
      1,
    );
    assert.ok(!q.ok);
    assert.equal(client.calls.filter(isData).length, 0);
  });

  it('per-collection still accepts a vector of another length', async () => {
    const client = makeFakeClient();
    const rag = plain(client);
    assert.ok((await rag.upsertPrecomputed('t', [1, 2], { id: 'a' })).ok);
    assert.ok(
      (await rag.query({ text: 'q', toVector: async () => [1, 2, 3, 4] }, 1))
        .ok,
    );
    assert.ok(client.calls.length >= 2);
  });

  it('a failed shared check reaches the caller with its own code', async () => {
    const rag = mk(recordingClient({ dim: 768 }));
    const q = await rag.query(
      { text: 'q', toVector: async () => [1, 2, 3] },
      1,
    );
    assert.ok(!q.ok);
    assert.equal(q.error.code, 'SHARED_LAYOUT_NOT_DEPLOYED');
    const up = await rag.upsertPrecomputed('t', [1, 2, 3], { id: 'a' });
    assert.ok(!up.ok);
    assert.equal(up.error.code, 'SHARED_LAYOUT_NOT_DEPLOYED');
  });

  it('healthCheck passes a failed shared check through with its own code and message', async () => {
    const rag = mk(recordingClient({ dim: 768 }));
    const h = await rag.healthCheck();
    assert.ok(!h.ok);
    assert.equal(h.error.code, 'SHARED_LAYOUT_NOT_DEPLOYED');
    assert.ok(!h.error.message.startsWith('RagError'));
    assert.match(h.error.message, /768/);
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
