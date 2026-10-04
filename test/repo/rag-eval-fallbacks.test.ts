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
import {
  fallbackVerdict,
  RerankFallbackCounter,
} from '../../scripts/rag-eval/rerank-fallbacks.js';

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

describe('rag-eval rerank fallbacks', () => {
  it('a failing reranker is counted per case although the strategy answers ok', async () => {
    const counter = new RerankFallbackCounter();
    const opts = { sessionLogger: counter.sessionLogger };
    const s = store([hit('a', 0.9), hit('b', 0.8)]);
    for (const strategy of [
      new RerankedRetrieval(unauthorized),
      new RerankAllRetrieval(unauthorized, { maxCandidates: 30 }),
    ]) {
      const wrapped = applyRetrievalStrategy(s, strategy);
      const res = await wrapped.query(new TextOnlyEmbedding('q'), 1, opts);
      assert.ok(res.ok, 'the strategy hides the failure behind ok');
      assert.equal(counter.take(), 1);
    }
    assert.equal(counter.take(), 0, 'take() resets');
    assert.match(counter.firstReason ?? '', /DECISION_AUTH: HTTP 401/);
  });

  it('a working reranker counts nothing; other steps are ignored', async () => {
    const counter = new RerankFallbackCounter();
    counter.sessionLogger.logStep('something_else', {});
    const ok: IReranker = { rerank: async (_q, r) => ({ ok: true, value: r }) };
    const wrapped = applyRetrievalStrategy(
      store([hit('a', 0.9)]),
      new RerankedRetrieval(ok),
    );
    await wrapped.query(new TextOnlyEmbedding('q'), 1, {
      sessionLogger: counter.sessionLogger,
    });
    assert.equal(counter.take(), 0);
  });

  it('any fallback in a rerank arm fails the run unless allowed', () => {
    const arms = [
      { label: 'c / embedding', reranks: false, fallbackCases: 0, cases: 30 },
      {
        label: 'c / rerank:decision',
        reranks: true,
        fallbackCases: 30,
        cases: 30,
        firstReason: 'DECISION_AUTH: HTTP 401',
      },
    ];
    const strict = fallbackVerdict(arms, false);
    assert.equal(strict.failed, true);
    assert.ok(
      strict.lines.some(
        (l) => l.includes('c / rerank:decision') && l.includes('30/30'),
      ),
    );
    const allowed = fallbackVerdict(arms, true);
    assert.equal(allowed.failed, false);
    assert.ok(allowed.lines.length > 0, 'still warns');
    assert.deepEqual(fallbackVerdict([arms[0]], false), {
      failed: false,
      lines: [],
    });
  });
});
