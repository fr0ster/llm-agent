/** Spec §9.3, D71: a failed rerank is RERANK_ERROR — never the embedding order. */
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
const store: IRag = {
  query: async (_q, k) => ({
    ok: true,
    value: [hit('a', 0.9), hit('b', 0.8), hit('c', 0.7)].slice(0, k),
  }),
  healthCheck: async () => ({ ok: true, value: undefined }),
  getById: async () => ({ ok: true, value: null }),
};
const q = { text: 'q', toVector: async () => [1] } as IQueryEmbedding;
const failing: IReranker = {
  rerank: async () => ({
    ok: false,
    error: new RagError('HTTP 401', 'DECISION_AUTH'),
  }),
};
const throwing: IReranker = {
  rerank: async () => {
    throw new Error('boom');
  },
};

const strategies = [
  ['RerankedRetrieval', (r: IReranker) => new RerankedRetrieval(r)],
  [
    'RerankAllRetrieval',
    (r: IReranker) => new RerankAllRetrieval(r, { maxCandidates: 3 }),
  ],
] as const;

for (const [name, make] of strategies) {
  describe(`${name} fails loud`, () => {
    it('a reranker answering ok: false → RERANK_ERROR', async () => {
      const steps: unknown[] = [];
      const r = await make(failing).retrieve(store, q, 2, {
        sessionLogger: { logStep: (n: string) => steps.push(n) },
      } as never);
      assert.ok(!r.ok);
      assert.equal(r.error.code, 'RERANK_ERROR');
      assert.match(r.error.message, /^rerank failed: DECISION_AUTH: /);
      assert.deepEqual(steps, ['retrieval_rerank_error']);
    });

    it('a throwing reranker → RERANK_ERROR carrying RERANK_THROWN', async () => {
      const r = await make(throwing).retrieve(store, q, 2);
      assert.ok(!r.ok);
      assert.equal(r.error.code, 'RERANK_ERROR');
      assert.match(r.error.message, /RERANK_THROWN/);
    });

    it('a short successful answer is still accepted (S4)', async () => {
      const r = await make({
        rerank: async (_q, res) => ({ ok: true, value: res.slice(0, 1) }),
      }).retrieve(store, q, 2);
      assert.ok(r.ok);
      assert.equal(r.value.length, 1);
    });
  });
}
