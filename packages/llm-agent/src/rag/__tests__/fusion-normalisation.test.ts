import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InvertedIndex } from '../inverted-index.js';
import {
  Bm25OnlyStrategy,
  type ISearchCandidate,
  type ISearchContext,
  WeightedFusionStrategy,
} from '../search-strategy.js';

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]/)
    .filter((t) => t.length > 1);
}

function ctx(cands: ISearchCandidate[]): ISearchContext {
  const index = new InvertedIndex();
  cands.forEach((c, i) => {
    index.add(i, tokenize(c.text));
  });
  return { index, tokenize };
}

const cand = (id: string, text: string, vector: number[]): ISearchCandidate =>
  ({
    id,
    text,
    vector,
    metadata: { id },
  }) as ISearchCandidate;

// Filler documents keep the query terms rare, so their IDF — and a matching
// document's raw BM25 — is high.
const filler = Array.from({ length: 30 }, (_, i) =>
  cand(`f${i}`, `unrelated filler words number ${i}`, [0, 1]),
);

describe('WeightedFusionStrategy normalises BM25 per query', () => {
  it('the best keyword match contributes exactly keywordWeight', () => {
    const cands = [
      cand('hit', 'transport release', [0, 1]),
      cand('other', 'nothing relevant here', [0, 1]),
    ];
    const s = new WeightedFusionStrategy({
      vectorWeight: 0.7,
      keywordWeight: 0.3,
    });
    const out = s.score(
      { text: 'transport release', vector: [1, 0] },
      cands,
      ctx(cands),
    );
    assert.equal(out[0].metadata.id, 'hit');
    // cosine([1,0],[0,1]) = 0, so the score is the keyword part alone.
    assert.ok(Math.abs(out[0].score - 0.3) < 1e-9, `score ${out[0].score}`);
    assert.equal(out[1].score, 0);
  });

  it('does not saturate: a stronger keyword match still ranks higher', () => {
    // Both raw BM25 scores are well above the old clamp point.
    const cands = [
      ...filler,
      cand('weaker', 'transport release request lock', [0, 1]),
      cand(
        'stronger',
        'transport release request lock transport release request lock',
        [0, 1],
      ),
    ];
    const s = new WeightedFusionStrategy();
    const out = s.score(
      { text: 'transport release request lock', vector: [1, 0] },
      cands,
      ctx(cands),
    );
    assert.equal(out[0].metadata.id, 'stronger');
    assert.ok(out[0].score > out[1].score);
  });
});

describe('BM25 ranking is not flattened by a clamp', () => {
  const cands = [
    ...filler,
    cand('weaker', 'transport release request lock', [0, 1]),
    cand(
      'stronger',
      'transport release request lock transport release request lock',
      [0, 1],
    ),
  ];
  const q = { text: 'transport release request lock', vector: [1, 0] };

  it('Bm25OnlyStrategy orders two strong matches by their raw score', () => {
    const out = new Bm25OnlyStrategy().score(q, cands, ctx(cands));
    assert.deepEqual(
      out.slice(0, 2).map((r) => r.metadata.id),
      ['stronger', 'weaker'],
    );
    assert.ok(out[0].score <= 1 && out[0].score > 0);
  });
});
