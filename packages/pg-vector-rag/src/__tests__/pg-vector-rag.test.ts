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
