import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { IEmbedder } from '@mcp-abap-adt/llm-agent';
import {
  QueryEmbedding,
  staticApiKey,
  symmetricEmbedder,
} from '@mcp-abap-adt/llm-agent';
import { type QdrantStub, startQdrantStub } from './__tests__/qdrant-stub.js';
import { QdrantRag } from './qdrant-rag.js';

// ---------------------------------------------------------------------------
// Stub embedder
// ---------------------------------------------------------------------------
function makeEmbedder(dim = 3): IEmbedder {
  return {
    async embed(text: string) {
      // Deterministic hash-based embedding
      let hash = 0;
      for (const ch of text) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
      return {
        vector: Array.from(
          { length: dim },
          (_, i) => ((hash >> i) & 0xff) / 255,
        ),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Stub Qdrant HTTP server
// ---------------------------------------------------------------------------
describe('QdrantRag', () => {
  let baseUrl: string;
  let state: QdrantStub;

  before(async () => {
    state = await startQdrantStub();
    baseUrl = state.baseUrl;
  });

  after(() => state.close());

  it('auto-creates collection on first upsert', async () => {
    const rag = new QdrantRag({
      url: baseUrl,
      collectionName: 'test-auto-create',
      embedder: symmetricEmbedder(makeEmbedder()),
    });
    assert.ok(!state.collections.has('test-auto-create'));
    const result = await rag.upsert('hello world', {});
    assert.ok(result.ok);
    assert.ok(state.collections.has('test-auto-create'));
  });

  it('upserts and queries documents', async () => {
    state.collections.set('test-query', { size: 3, points: new Map() });
    const rag = new QdrantRag({
      url: baseUrl,
      collectionName: 'test-query',
      embedder: symmetricEmbedder(makeEmbedder()),
    });

    await rag.upsert('ABAP SELECT statement', { namespace: 'docs' });
    await rag.upsert('JavaScript forEach loop', { namespace: 'docs' });

    const embedder = symmetricEmbedder(makeEmbedder());
    const result = await rag.query(
      new QueryEmbedding('ABAP SELECT', embedder),
      5,
    );
    assert.ok(result.ok);
    assert.ok(result.value.length > 0);
    assert.ok(result.value[0].text.length > 0);
    assert.ok(result.value[0].score > 0);
  });

  it('healthCheck succeeds when collection exists', async () => {
    state.collections.set('test-health', { size: 3, points: new Map() });
    const rag = new QdrantRag({
      url: baseUrl,
      collectionName: 'test-health',
      embedder: symmetricEmbedder(makeEmbedder()),
    });
    const result = await rag.healthCheck();
    assert.ok(result.ok);
  });

  it('healthCheck fails when collection does not exist', async () => {
    const rag = new QdrantRag({
      url: baseUrl,
      collectionName: 'nonexistent',
      embedder: symmetricEmbedder(makeEmbedder()),
    });
    const result = await rag.healthCheck();
    assert.ok(!result.ok);
    assert.equal(result.error.code, 'HEALTH_CHECK_ERROR');
  });

  it('handles connection errors gracefully', async () => {
    const rag = new QdrantRag({
      url: 'http://127.0.0.1:1',
      collectionName: 'unreachable',
      embedder: symmetricEmbedder(makeEmbedder()),
      timeoutMs: 1000,
    });
    const result = await rag.healthCheck();
    assert.ok(!result.ok);
    assert.equal(result.error.code, 'HEALTH_CHECK_ERROR');
  });

  it('passes api-key header when configured', async () => {
    state.collections.set('test-auth', { size: 3, points: new Map() });
    // This just tests that the constructor accepts a credential without error
    const rag = new QdrantRag({
      url: baseUrl,
      collectionName: 'test-auth',
      embedder: symmetricEmbedder(makeEmbedder()),
      credential: staticApiKey('test-secret'),
    });
    const result = await rag.healthCheck();
    assert.ok(result.ok);
  });

  it('getById returns the stored record via deterministic UUID', async () => {
    state.collections.set('test-get', { size: 3, points: new Map() });
    const rag = new QdrantRag({
      url: baseUrl,
      collectionName: 'test-get',
      embedder: symmetricEmbedder(makeEmbedder()),
    });
    await rag.upsert('hello', { id: 'r1' });
    const got = await rag.getById?.('r1');
    assert.ok(got.ok);
    assert.ok(got.value);
    assert.equal(got.value?.text, 'hello');
  });

  it('getById returns null for unknown id', async () => {
    state.collections.set('test-get-miss', { size: 3, points: new Map() });
    const rag = new QdrantRag({
      url: baseUrl,
      collectionName: 'test-get-miss',
      embedder: symmetricEmbedder(makeEmbedder()),
    });
    const got = await rag.getById?.('nope');
    assert.ok(got.ok);
    assert.equal(got.value, null);
  });

  it('writer().deleteByIdRaw removes the point', async () => {
    state.collections.set('test-del', { size: 3, points: new Map() });
    const rag = new QdrantRag({
      url: baseUrl,
      collectionName: 'test-del',
      embedder: symmetricEmbedder(makeEmbedder()),
    });
    const w = rag.writer();
    await w.upsertRaw('r1', 'hi', {});
    assert.equal(state.collections.get('test-del')?.points.size, 1);
    const del = await w.deleteByIdRaw('r1');
    assert.ok(del.ok);
    assert.equal(state.collections.get('test-del')?.points.size, 0);
  });

  it('writer().upsertManyPrecomputedRaw writes every point in one batch', async () => {
    state.collections.set('test-bulk', { size: 2, points: new Map() });
    const firstRequest = state.requests.length;
    const rag = new QdrantRag({
      url: baseUrl,
      collectionName: 'test-bulk',
      embedder: symmetricEmbedder(makeEmbedder()),
    });
    const w = rag.writer();
    const res = await w.upsertManyPrecomputedRaw?.([
      { id: 'a', text: 'ta', vector: [0.1, 0.2], metadata: {} },
      { id: 'b', text: 'tb', vector: [0.3, 0.4], metadata: {} },
      { id: 'c', text: 'tc', vector: [0.5, 0.6], metadata: {} },
    ]);
    assert.ok(res?.ok, 'bulk upsert should succeed');
    assert.equal(state.collections.get('test-bulk')?.points.size, 3);
    assert.equal(
      state.requests
        .slice(firstRequest)
        .filter(({ path }) => path.endsWith('/points/batch')).length,
      1,
    );
  });

  it('writer().clearAll empties the collection', async () => {
    state.collections.set('test-clear', { size: 3, points: new Map() });
    const rag = new QdrantRag({
      url: baseUrl,
      collectionName: 'test-clear',
      embedder: symmetricEmbedder(makeEmbedder()),
    });
    const w = rag.writer();
    await w.upsertRaw('a', 't', {});
    await w.upsertRaw('b', 't', {});
    const cleared = await w.clearAll?.();
    assert.ok(cleared?.ok);
    assert.equal(state.collections.get('test-clear')?.points.size, 0);
  });
});

describe('QdrantRag — session/user filter (security)', () => {
  async function searchBody(
    ragFilter?: Record<string, unknown>,
    k = 3,
  ): Promise<Record<string, unknown>> {
    let captured: Record<string, unknown> | undefined;
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      if (String(input).endsWith('/points/query/groups')) {
        captured = JSON.parse(String(init?.body));
      }
      const result = String(input).endsWith('/points/query/groups')
        ? { groups: [] }
        : { points: [] };
      return Response.json({ result });
    }) as typeof fetch;
    try {
      const rag = new QdrantRag({
        url: 'http://qdrant.invalid',
        collectionName: 'c',
        embedder: symmetricEmbedder(makeEmbedder()),
      });
      const r = await rag.query(
        { text: 'q', toVector: async () => [0.1, 0.2, 0.3] },
        k,
        ragFilter ? { ragFilter } : undefined,
      );
      assert.equal(r.ok, true);
    } finally {
      globalThis.fetch = origFetch;
    }
    if (!captured) throw new Error('no search request issued');
    return captured;
  }

  // upsert spreads metadata flat into the payload, so the keys are top-level.
  const sessionCond = { key: 'sessionId', match: { value: 's1' } };
  const userCond = { key: 'userId', match: { value: 'u1' } };

  it('sessionId and userId become top-level must conditions of the search filter', async () => {
    const body = await searchBody({ sessionId: 's1', userId: 'u1' }, 3);
    const filter = body.filter as { must?: unknown[] };
    assert.ok(Array.isArray(filter.must));
    assert.deepEqual(
      filter.must?.filter((c) =>
        ['sessionId', 'userId'].includes((c as { key: string }).key),
      ),
      [sessionCond, userCond],
    );
    // Server-side filtering: the limit stays k (no over-fetch).
    assert.equal(body.limit, 3);
  });

  it('userId alone adds only the userId condition', async () => {
    const body = await searchBody({ userId: 'u1' });
    const must = (body.filter as { must?: unknown[] }).must ?? [];
    assert.deepEqual(
      must.filter((c) =>
        ['sessionId', 'userId'].includes((c as { key: string }).key),
      ),
      [userCond],
    );
  });

  it('no identity filter adds no identity condition', async () => {
    const body = await searchBody();
    assert.ok(!JSON.stringify(body).includes('"sessionId"'));
    assert.ok(!JSON.stringify(body).includes('"userId"'));
  });
});
