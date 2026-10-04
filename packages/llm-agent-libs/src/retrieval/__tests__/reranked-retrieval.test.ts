import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type IQueryEmbedding,
  type IRag,
  type IReranker,
  RagError,
  type RagResult,
} from '@mcp-abap-adt/llm-agent';
import { RerankAllRetrieval, RerankedRetrieval } from '../index.js';

const hit = (id: string, score: number): RagResult => ({
  text: id,
  metadata: { id },
  score,
});

function fakeStore(results: RagResult[]) {
  const calls: Array<{ k: number; options: unknown }> = [];
  const writer = {
    upsertRaw: async () => ({ ok: true as const, value: undefined }),
  };
  const store: IRag = {
    query: async (_q, k, options) => {
      calls.push({ k, options });
      return { ok: true, value: results.slice(0, k) };
    },
    healthCheck: async () => ({ ok: true, value: undefined }),
    getById: async (id) => ({
      ok: true,
      value: results.find((r) => r.metadata.id === id) ?? null,
    }),
    writer: () => writer as never,
  };
  return { store, calls, writer };
}
const q = { text: 'q', toVector: async () => [1] } as IQueryEmbedding;

describe('RerankedRetrieval', () => {
  it('fetches k × overfetch, reranks with the query text, returns top-k', async () => {
    const { store, calls } = fakeStore([
      hit('a', 0.9),
      hit('b', 0.8),
      hit('c', 0.7),
      hit('d', 0.6),
    ]);
    const seen: Array<{ query: string; n: number; options: unknown }> = [];
    const reranker: IReranker = {
      rerank: async (query, results, options) => {
        seen.push({ query, n: results.length, options });
        return {
          ok: true,
          value: [...results]
            .reverse()
            .map((r, i) => ({ ...r, score: 1 - i / 10 })),
        };
      },
    };
    const opts = { sessionId: 's' };
    const r = await new RerankedRetrieval(reranker, { overfetch: 2 }).retrieve(
      store,
      q,
      2,
      opts,
    );
    assert.ok(r.ok);
    assert.deepEqual(calls[0].k, 4);
    assert.deepEqual(seen, [{ query: 'q', n: 4, options: opts }]);
    assert.deepEqual(
      r.value.map((x) => x.text),
      ['d', 'c'],
    );
  });

  it('a reranker failure returns the embedding top-k and logs retrieval_rerank_error', async () => {
    const { store } = fakeStore([hit('a', 0.9), hit('b', 0.8), hit('c', 0.7)]);
    const steps: Array<[string, unknown]> = [];
    const reranker: IReranker = {
      rerank: async () => ({
        ok: false,
        error: new RagError('down', 'RERANK_ERROR'),
      }),
    };
    const r = await new RerankedRetrieval(reranker, {
      storeName: 'tools',
    }).retrieve(store, q, 2, {
      sessionLogger: { logStep: (n: string, d: unknown) => steps.push([n, d]) },
    } as never);
    assert.ok(r.ok);
    assert.deepEqual(
      r.value.map((x) => x.text),
      ['a', 'b'],
    );
    assert.deepEqual(steps, [
      [
        'retrieval_rerank_error',
        {
          store: 'tools',
          strategy: 'rerank',
          code: 'RERANK_ERROR',
          message: 'down',
        },
      ],
    ]);
  });

  it('a store error is returned as is (nothing to fall back to)', async () => {
    const store = {
      ...fakeStore([]).store,
      query: async () => ({
        ok: false as const,
        error: new RagError('x', 'RAG_ERROR'),
      }),
    };
    const r = await new RerankedRetrieval({
      rerank: async () => {
        throw new Error('unused');
      },
    }).retrieve(store, q, 2);
    assert.ok(!r.ok);
  });

  it('a throwing reranker is treated as a failure', async () => {
    const { store } = fakeStore([hit('a', 0.9)]);
    const steps: Array<[string, Record<string, unknown>]> = [];
    const r = await new RerankedRetrieval({
      rerank: async () => {
        throw new Error('boom');
      },
    }).retrieve(store, q, 1, {
      sessionLogger: {
        logStep: (n: string, d: Record<string, unknown>) => steps.push([n, d]),
      },
    } as never);
    assert.ok(r.ok);
    assert.deepEqual(
      r.value.map((x) => x.text),
      ['a'],
    );
    assert.equal(steps[0][1].code, 'RERANK_THROWN');
    assert.equal(steps[0][1].message, 'Error: boom');
  });

  it('truncates a thrown error to 500 characters in the step', async () => {
    const { store } = fakeStore([hit('a', 0.9)]);
    const steps: Array<Record<string, unknown>> = [];
    await new RerankedRetrieval({
      rerank: async () => {
        throw new Error('x'.repeat(2000));
      },
    }).retrieve(store, q, 1, {
      sessionLogger: {
        logStep: (_n: string, d: Record<string, unknown>) => steps.push(d),
      },
    } as never);
    assert.equal((steps[0].message as string).length, 500);
  });
});

describe('RerankAllRetrieval', () => {
  it('fetches maxCandidates (not k), reranks all, returns top-k', async () => {
    const { store, calls } = fakeStore([
      hit('a', 0.9),
      hit('b', 0.8),
      hit('c', 0.7),
    ]);
    const reranker: IReranker = {
      rerank: async (_q, results) => ({
        ok: true,
        value: [...results].reverse(),
      }),
    };
    const r = await new RerankAllRetrieval(reranker, {
      maxCandidates: 50,
    }).retrieve(store, q, 1);
    assert.equal(calls[0].k, 50);
    assert.ok(r.ok);
    assert.deepEqual(
      r.value.map((x) => x.text),
      ['c'],
    );
  });
});
