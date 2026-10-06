// packages/llm-agent-libs/src/collections/__tests__/staged-retrieval-decompose.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type IQueryDecomposer,
  type IQueryEmbedder,
  type IRag,
  type IReranker,
  RagError,
  type SubQuery,
} from '@mcp-abap-adt/llm-agent';
import { InMemoryRag } from '@mcp-abap-adt/llm-agent-rag';
import {
  FixedItemsCut,
  ItemPool,
  MaxScoreCollapse,
  ScoreFloorCut,
  StagedRetrieval,
  type StagedRetrievalOptions,
} from '../index.js';
import { ids, matchesOnly, put, q } from './staged-retrieval-helpers.js';

const embedder: IQueryEmbedder = { embedQuery: async () => ({ vector: [1] }) };
const decomposer = (
  subs: SubQuery[] | Error | 'throw',
  seen: Array<[string, number]> = [],
): IQueryDecomposer => ({
  name: 'test-split',
  decompose: async (text, budget) => {
    seen.push([text, budget]);
    if (subs === 'throw') throw new Error('boom');
    if (subs instanceof Error)
      return { ok: false, error: new RagError(subs.message) };
    return { ok: true, value: subs };
  },
});

async function fixture(queries: string[] = []) {
  const raw = new InMemoryRag();
  await put(raw, 'A', [['full', 'apple one']]);
  await put(raw, 'B', [['full', 'apple banana']]);
  await put(raw, 'C', [['full', 'banana cherry']]);
  await put(raw, 'D', [['full', 'cherry date']]);
  const inner = matchesOnly(raw);
  const rag: IRag = {
    ...inner,
    query: (e, k, o) => {
      queries.push(e.text);
      return inner.query(e, k, o);
    },
  };
  return rag;
}

function staged(rag: IRag, o: Partial<StagedRetrievalOptions>) {
  return new StagedRetrieval({
    name: 'test',
    storeKey: 'tools',
    pool: new ItemPool(10),
    maxRecordsPerItem: 1,
    canonicalKind: 'full',
    sources: {
      sources: async (options) => [{ name: 'primary', rag, options }],
    },
    collapse: new MaxScoreCollapse(),
    ...o,
  });
}

describe('StagedRetrieval — query decomposition slot', () => {
  it('none injected → the query runs as is, once', async () => {
    const queries: string[] = [];
    const rag = await fixture(queries);
    await staged(rag, {}).retrieve(rag, q('apple banana'), 3);
    assert.deepEqual(queries, ['apple banana']);
  });

  it('[] → one run with the whole budget', async () => {
    const queries: string[] = [];
    const seen: Array<[string, number]> = [];
    const rag = await fixture(queries);
    const r = await staged(rag, {
      decompose: { decomposer: decomposer([], seen), queryEmbedder: embedder },
    }).retrieve(rag, q('apple'), 2);
    assert.deepEqual(seen, [['apple', 2]]);
    assert.deepEqual(queries, ['apple']);
    assert.ok(r.ok && r.value.length === 2);
  });

  it('the budget handed to the decomposer is min(k, cut.limit(k)) (F1)', async () => {
    const seen: Array<[string, number]> = [];
    const rag = await fixture();
    const s = staged(rag, {
      cut: new FixedItemsCut(3),
      decompose: { decomposer: decomposer([], seen), queryEmbedder: embedder },
    });
    await s.retrieve(rag, q('apple'), 20);
    await s.retrieve(rag, q('apple'), 2);
    assert.deepEqual(seen, [
      ['apple', 3],
      ['apple', 2],
    ]);
  });

  it('each sub-query is reranked against its own text and kept to its k; the union is de-duplicated', async () => {
    const asked: string[] = [];
    const reranker: IReranker = {
      rerank: async (query, results) => {
        asked.push(query);
        return { ok: true, value: results };
      },
    };
    const rag = await fixture();
    const r = await staged(rag, {
      rerank: { reranker },
      decompose: {
        decomposer: decomposer([
          { text: 'apple', k: 1 },
          { text: 'banana', k: 2 },
        ]),
        queryEmbedder: embedder,
      },
    }).retrieve(rag, q('apple then banana'), 3);
    assert.deepEqual(asked.sort(), ['apple', 'banana']);
    assert.ok(r.ok);
    assert.equal(
      new Set(r.value.map((x) => x.metadata.id)).size,
      r.value.length,
    );
    assert.ok(r.value.length <= 3);
  });

  it("without a pool, each sub-query's pool is its own k items (D56)", async () => {
    const asks: Array<[string, number]> = [];
    const inner = await fixture();
    const rag: IRag = {
      ...inner,
      query: (e, k, o) => {
        asks.push([e.text, k]);
        return inner.query(e, k, o);
      },
    };
    await staged(rag, {
      pool: undefined,
      decompose: {
        decomposer: decomposer([
          { text: 'apple', k: 1 },
          { text: 'banana', k: 2 },
        ]),
        queryEmbedder: embedder,
      },
    }).retrieve(rag, q('apple then banana'), 3);
    // maxRecordsPerItem is 1 here: records to fetch = the sub-query's k.
    assert.deepEqual(asks.sort(), [
      ['apple', 1],
      ['banana', 2],
    ]);
  });

  it('budgets summing above the budget are a DECOMPOSE_ERROR — never a silent fall-back', async () => {
    const rag = await fixture();
    for (const subs of [
      [
        { text: 'apple', k: 2 },
        { text: 'banana', k: 2 },
      ],
      [{ text: 'apple', k: 0 }],
      [{ text: 'apple', k: 1.5 }],
      [{ text: '  ', k: 1 }],
    ]) {
      const r = await staged(rag, {
        decompose: { decomposer: decomposer(subs), queryEmbedder: embedder },
      }).retrieve(rag, q('x'), 3);
      assert.equal(r.ok, false);
      assert.ok(
        !r.ok && r.error.code === 'DECOMPOSE_ERROR',
        JSON.stringify(subs),
      );
    }
  });

  it('a decomposer error or throw is a DECOMPOSE_ERROR', async () => {
    const rag = await fixture();
    for (const d of [decomposer(new Error('no')), decomposer('throw')]) {
      const r = await staged(rag, {
        decompose: { decomposer: d, queryEmbedder: embedder },
      }).retrieve(rag, q('x'), 3);
      assert.ok(!r.ok && r.error.code === 'DECOMPOSE_ERROR');
    }
  });

  it("a failing decomposer's own code and message travel in the DECOMPOSE_ERROR; a throw is named", async () => {
    const rag = await fixture();
    const coded: IQueryDecomposer = {
      name: 'coded',
      decompose: async () => ({
        ok: false,
        error: new RagError('quota exhausted', 'LLM_QUOTA'),
      }),
    };
    const failed = await staged(rag, {
      decompose: { decomposer: coded, queryEmbedder: embedder },
    }).retrieve(rag, q('x'), 3);
    assert.ok(!failed.ok && failed.error.code === 'DECOMPOSE_ERROR');
    assert.ok(
      !failed.ok &&
        failed.error.message.includes('coded') &&
        failed.error.message.includes('LLM_QUOTA: quota exhausted'),
      !failed.ok ? failed.error.message : '',
    );
    const thrown = await staged(rag, {
      decompose: { decomposer: decomposer('throw'), queryEmbedder: embedder },
    }).retrieve(rag, q('x'), 3);
    assert.ok(
      !thrown.ok &&
        /decomposer test-split threw: Error: boom/.test(thrown.error.message),
      !thrown.ok ? thrown.error.message : '',
    );
  });

  it('never more than the budget with any decomposer', async () => {
    const rag = await fixture();
    const r = await staged(rag, {
      decompose: {
        decomposer: decomposer([
          { text: 'apple', k: 1 },
          { text: 'cherry', k: 1 },
        ]),
        queryEmbedder: embedder,
      },
    }).retrieve(rag, q('x'), 2);
    assert.ok(r.ok && r.value.length <= 2);
    // Each sub-query keeps its own k (1): one 'apple' item, then one 'cherry' item, in sub-query order.
    const got = ids(r) as unknown[];
    assert.equal(got.length, 2);
    assert.ok(
      ['A', 'B'].includes(String(got[0])),
      `apple's item first, got ${String(got[0])}`,
    );
    assert.ok(
      ['C', 'D'].includes(String(got[1])),
      `cherry's item second, got ${String(got[1])}`,
    );
  });

  it('the same item from two sub-queries with different scores is kept once, at its first position, with its first score (D63)', async () => {
    // A score is comparable only for the same query (spec §3.9, D28): each sub-query gets its own scale.
    const scores: Record<string, Record<string, number>> = {
      apple: { 'apple one': 0.9, 'apple banana': 0.2 },
      banana: { 'apple banana': 0.95, 'banana cherry': 0.5 },
    };
    const reranker: IReranker = {
      rerank: async (query, results) => ({
        ok: true,
        value: results
          .map((r) => ({ ...r, score: scores[query]?.[r.text] ?? 0 }))
          .sort((a, b) => b.score - a.score),
      }),
    };
    const rag = await fixture();
    const r = await staged(rag, {
      rerank: { reranker },
      decompose: {
        decomposer: decomposer([
          { text: 'apple', k: 2 },
          { text: 'banana', k: 2 },
        ]),
        queryEmbedder: embedder,
      },
    }).retrieve(rag, q('apple then banana'), 4);
    assert.ok(r.ok);
    // apple's list [A 0.9, B 0.2], then banana's [B 0.95, C 0.5]: B stays where apple put it, with
    // apple's score (no best-score pick across queries), and the union is not re-sorted (C's 0.5 after B's 0.2).
    assert.deepEqual(
      r.value.map((x) => [x.metadata.id, x.score]),
      [
        ['A', 0.9],
        ['B', 0.2],
        ['C', 0.5],
      ],
    );
    assert.ok(r.value.length <= 4);
  });

  it('a decomposer with ScoreFloorCut is rejected at construction — sub-query scores are not comparable (D63)', async () => {
    const rag = await fixture();
    const floor = new ScoreFloorCut({
      minItems: 1,
      maxItems: 3,
      minScore: 0.5,
    });
    const decompose = {
      decomposer: decomposer([
        { text: 'apple', k: 1 },
        { text: 'banana', k: 1 },
      ]),
      queryEmbedder: embedder,
    };
    const reranker: IReranker = {
      rerank: async (_query, results) => ({ ok: true, value: results }),
    };
    const rejected: Partial<StagedRetrievalOptions>[] = [
      { cut: floor, decompose },
      // also where the floor alone is allowed (with a reranker, spec §4.7, D71)
      { cut: floor, decompose, rerank: { reranker } },
    ];
    for (const o of rejected) {
      assert.throws(
        () => staged(rag, o),
        /^Error: StagedRetrieval: a decomposer cannot be combined with ScoreFloorCut — scores of different sub-queries are not comparable/,
      );
    }
    // The floor without a decomposer, and a decomposer with a rank-order cut, stay allowed.
    assert.doesNotThrow(() => staged(rag, { cut: floor }));
    assert.doesNotThrow(() =>
      staged(rag, { cut: new FixedItemsCut(3), decompose }),
    );
  });
});
