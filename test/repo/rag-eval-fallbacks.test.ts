import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type IRag,
  type IReranker,
  RagError,
  type RagResult,
  TextOnlyEmbedding,
} from '../../packages/llm-agent/src/index.js';
import {
  applyRetrievalStrategy,
  RerankAllRetrieval,
  RerankedRetrieval,
} from '../../packages/llm-agent-libs/src/retrieval/index.js';
import { rerankErrorVerdict } from '../../scripts/rag-eval/rerank-errors.js';

const hit = (id: string, score: number): RagResult => ({
  text: id,
  metadata: { id },
  score,
});

function store(results: RagResult[]): IRag {
  return {
    query: async (_q, k) => ({ ok: true, value: results.slice(0, k) }),
    healthCheck: async () => ({ ok: true, value: undefined }),
    getById: async () => ({ ok: true, value: null }),
  };
}

/** Every rerank call fails as an HTTP 401 would — no network involved. */
const unauthorized: IReranker = {
  rerank: async () => ({
    ok: false,
    error: new RagError('HTTP 401 Unauthorized', 'DECISION_AUTH'),
  }),
};

describe('rag-eval rerank errors — no fallback (D71)', () => {
  it('a failing reranker is a RERANK_ERROR from both strategies', async () => {
    const s = store([hit('a', 0.9), hit('b', 0.8)]);
    for (const strategy of [
      new RerankedRetrieval(unauthorized),
      new RerankAllRetrieval(unauthorized, { maxCandidates: 30 }),
    ]) {
      const wrapped = applyRetrievalStrategy(s, strategy);
      const res = await wrapped.query(new TextOnlyEmbedding('q'), 1);
      assert.ok(!res.ok);
      assert.equal(res.error.code, 'RERANK_ERROR');
      assert.match(res.error.message, /DECISION_AUTH: HTTP 401/);
    }
  });

  it('a working reranker answers ok with its order', async () => {
    const ok: IReranker = {
      rerank: async (_q, r) => ({ ok: true, value: [...r].reverse() }),
    };
    const wrapped = applyRetrievalStrategy(
      store([hit('a', 0.9), hit('b', 0.8)]),
      new RerankedRetrieval(ok),
    );
    const res = await wrapped.query(new TextOnlyEmbedding('q'), 2);
    assert.ok(res.ok);
    assert.deepEqual(
      res.value.map((r) => r.text),
      ['b', 'a'],
    );
  });

  it('any failed case in a rerank arm fails the run', () => {
    const failed = rerankErrorVerdict([
      {
        label: 'c / rerank:decision',
        errorCases: 30,
        cases: 30,
        firstError: 'DECISION_AUTH: HTTP 401',
      },
    ]);
    assert.equal(failed.failed, true);
    assert.ok(
      failed.lines.some(
        (l) =>
          l.includes('c / rerank:decision') &&
          l.includes('30/30') &&
          l.includes('DECISION_AUTH: HTTP 401'),
      ),
    );
    assert.deepEqual(
      rerankErrorVerdict([{ label: 'c / rerank', errorCases: 0, cases: 30 }]),
      { failed: false, lines: [] },
    );
  });
});
