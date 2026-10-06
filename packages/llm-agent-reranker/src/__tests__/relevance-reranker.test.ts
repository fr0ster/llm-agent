// packages/llm-agent-reranker/src/__tests__/relevance-reranker.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DecisionError,
  type IRelevanceDecision,
  type RagResult,
  type RelevanceRequest,
  type RelevanceScore,
} from '@mcp-abap-adt/llm-agent';
import { RelevanceReranker } from '../index.js';

const mk = (n: number, len = 8): RagResult[] =>
  Array.from({ length: n }, (_, i) => ({
    text: `p${i}`.padEnd(len, 'x'),
    metadata: { id: `p${i}` },
    score: 0.5,
  }));
const ids = (r: RagResult[]) => r.map((x) => x.metadata.id);

function decision(
  answer: (req: RelevanceRequest) => readonly RelevanceScore[] | DecisionError,
) {
  const calls: RelevanceRequest[] = [];
  let inFlight = 0;
  let peak = 0;
  const d: IRelevanceDecision = {
    model: 'fake',
    score: async (req) => {
      calls.push(req);
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      const a = answer(req);
      return a instanceof DecisionError
        ? { ok: false, error: a }
        : { ok: true, value: { model: 'fake', scores: a } };
    },
  };
  return { d, calls, peak: () => peak };
}
const byLength = (req: RelevanceRequest) =>
  req.passages.map((p, index) => ({ index, score: p.length }));
/** score = the passage's number (`p7xxx` → 7): the merged order is known whatever the batching. */
const byNumber = (req: RelevanceRequest) =>
  req.passages.map((p, index) => ({
    index,
    score: Number.parseInt(p.slice(1), 10),
  }));

describe('RelevanceReranker (spec §5.2)', () => {
  it('a small set under the default budget: ONE call; score = the relevance score; sorted, ties in input order', async () => {
    const { d, calls } = decision((req) =>
      req.passages.map((_, index) => ({
        index,
        score: [0.2, 3.5, 0.2][index],
      })),
    );
    const r = await new RelevanceReranker(d).rerank('q', mk(3));
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      query: 'q',
      passages: mk(3).map((x) => x.text),
    });
    assert.ok(r.ok);
    assert.deepEqual(ids(r.value), ['p1', 'p0', 'p2']);
    assert.equal(
      r.value[0].score,
      3.5,
      'not clamped: a relevance score is not a probability',
    );
  });
  it('no candidates → no call', async () => {
    const { d, calls } = decision(byLength);
    const r = await new RelevanceReranker(d).rerank('q', []);
    assert.ok(r.ok && r.value.length === 0);
    assert.equal(calls.length, 0);
  });
  it('scores in any order are mapped by index', async () => {
    const { d } = decision(() => [
      { index: 1, score: 0.9 },
      { index: 0, score: 0.1 },
    ]);
    const r = await new RelevanceReranker(d).rerank('q', mk(2));
    assert.ok(r.ok);
    assert.deepEqual(ids(r.value), ['p1', 'p0']);
  });
  const badAnswers: Array<[string, readonly RelevanceScore[]]> = [
    ['a wrong count', [{ index: 0, score: 1 }]],
    [
      'a duplicate index',
      [
        { index: 0, score: 1 },
        { index: 0, score: 1 },
      ],
    ],
    [
      'an out-of-range index',
      [
        { index: 0, score: 1 },
        { index: 2, score: 1 },
      ],
    ],
    [
      'a non-integer index',
      [
        { index: 0, score: 1 },
        { index: 0.5, score: 1 },
      ],
    ],
    [
      'a non-finite score',
      [
        { index: 0, score: 1 },
        { index: 1, score: Number.NaN },
      ],
    ],
  ];
  for (const [name, answer] of badAnswers) {
    it(`${name} → RERANK_ERROR`, async () => {
      const { d } = decision(() => answer);
      const r = await new RelevanceReranker(d).rerank('q', mk(2));
      assert.ok(!r.ok && r.error.code === 'RERANK_ERROR');
    });
  }
  it('a DecisionError → RERANK_ERROR, message as the probability reranker words it (spec §5.2 item 4)', async () => {
    const { d } = decision(
      () => new DecisionError('down', 'DECISION_UNAVAILABLE'),
    );
    const r = await new RelevanceReranker(d).rerank('q', mk(2));
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'RERANK_ERROR');
    assert.equal(
      r.error.message,
      'decision rerank failed: DECISION_UNAVAILABLE: down',
    );
  });
  it('batches by default: over the default 48000-token budget → several calls, scores merged across calls by score (D28)', async () => {
    const { d, calls } = decision(byNumber);
    const results = mk(60, 4000); // ~1000 tokens each → two batches under 48000
    const r = await new RelevanceReranker(d).rerank('q', results);
    assert.ok(r.ok && r.value.length === 60);
    assert.equal(calls.length, 2);
    assert.deepEqual(
      calls.flatMap((c) => c.passages),
      results.map((x) => x.text),
      'every passage scored once, in batch order',
    );
    // the highest scores sit in the SECOND call: merging orders across calls, not per call
    assert.deepEqual(ids(r.value).slice(0, 3), ['p59', 'p58', 'p57']);
    assert.deepEqual(ids(r.value).at(-1), 'p0');
  });
  it('maxBatchTokens set → several calls, up to concurrency in flight, merged into one order by score', async () => {
    const { d, calls, peak } = decision(byNumber);
    const results = mk(6, 40); // ~10 tokens each
    const r = await new RelevanceReranker(d, {
      maxBatchTokens: 25,
      concurrency: 2,
    }).rerank('q', results);
    assert.ok(r.ok && r.value.length === 6);
    assert.ok(calls.length > 1);
    assert.ok(peak() <= 2);
    assert.deepEqual(
      calls.flatMap((c) => c.passages).sort(),
      results.map((x) => x.text).sort(),
    );
    assert.deepEqual(ids(r.value), ['p5', 'p4', 'p3', 'p2', 'p1', 'p0']);
  });
  it('a passage larger than the budget is a batch of its own, never dropped', async () => {
    const { d, calls } = decision(byNumber);
    const r = await new RelevanceReranker(d, { maxBatchTokens: 50 }).rerank(
      'q',
      mk(3, 400),
    ); // ~100 tokens each
    assert.ok(r.ok && r.value.length === 3);
    assert.deepEqual(
      calls.map((c) => c.passages.length),
      [1, 1, 1],
    );
  });
  it('any failed batch fails the whole rerank', async () => {
    let n = 0;
    const { d } = decision((req) =>
      n++ === 1 ? new DecisionError('x') : byLength(req),
    );
    const r = await new RelevanceReranker(d, { maxBatchTokens: 25 }).rerank(
      'q',
      mk(6, 40),
    );
    assert.ok(!r.ok && r.error.code === 'RERANK_ERROR');
  });
  it('options are validated as ProbabilityReranker validates them: positive integers', () => {
    const { d } = decision(byLength);
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      assert.throws(
        () => new RelevanceReranker(d, { maxBatchTokens: bad }),
        /maxBatchTokens/,
      );
      assert.throws(
        () => new RelevanceReranker(d, { concurrency: bad }),
        /concurrency/,
      );
    }
    assert.doesNotThrow(() => new RelevanceReranker(d));
  });
});
