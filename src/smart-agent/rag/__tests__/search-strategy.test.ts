import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InvertedIndex } from '../inverted-index.js';
import {
  Bm25OnlyStrategy,
  type ISearchCandidate,
  type ISearchContext,
  RrfStrategy,
  VectorOnlyStrategy,
  WeightedFusionStrategy,
} from '../search-strategy.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]/)
    .filter((t) => t.length > 1);
}

function tfVector(text: string, vocab: string[]): number[] {
  const tokens = tokenize(text);
  const freq = new Map<string, number>();
  for (const t of tokens) freq.set(t, (freq.get(t) ?? 0) + 1);
  const vec = vocab.map((term) => freq.get(term) ?? 0);
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  if (norm > 0) for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return vec;
}

function makeContext(candidates: ISearchCandidate[]): ISearchContext {
  const index = new InvertedIndex();
  for (let i = 0; i < candidates.length; i++) {
    index.add(i, tokenize(candidates[i].text));
  }
  return { index, tokenize };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const VOCAB = [
  'machine',
  'learning',
  'database',
  'sql',
  'neural',
  'network',
  'query',
];

const CANDIDATES: ISearchCandidate[] = [
  {
    text: 'machine learning and neural network',
    vector: tfVector('machine learning and neural network', VOCAB),
    metadata: { id: 'ml' },
  },
  {
    text: 'database and sql query',
    vector: tfVector('database and sql query', VOCAB),
    metadata: { id: 'db' },
  },
  {
    text: 'machine learning database integration',
    vector: tfVector('machine learning database integration', VOCAB),
    metadata: { id: 'both' },
  },
];

describe('WeightedFusionStrategy', () => {
  const vocab = VOCAB;
  const candidates = CANDIDATES;

  it('name property equals weighted-fusion', () => {
    const strategy = new WeightedFusionStrategy();
    assert.equal(strategy.name, 'weighted-fusion');
  });

  it('scores all candidates and returns them sorted descending', () => {
    const strategy = new WeightedFusionStrategy();
    const context = makeContext(candidates);
    const queryText = 'machine learning';
    const results = strategy.score(
      { text: queryText, vector: tfVector(queryText, vocab) },
      candidates,
      context,
    );

    assert.equal(results.length, candidates.length);
    for (let i = 0; i < results.length - 1; i++) {
      assert.ok(
        results[i].score >= results[i + 1].score,
        `Result ${i} score (${results[i].score}) should be >= result ${i + 1} score (${results[i + 1].score})`,
      );
    }
  });

  it('top result is the most relevant candidate for a known query', () => {
    const strategy = new WeightedFusionStrategy();
    const context = makeContext(candidates);
    const queryText = 'machine learning neural';
    const results = strategy.score(
      { text: queryText, vector: tfVector(queryText, vocab) },
      candidates,
      context,
    );

    // The ML candidate matches best for "machine learning neural" query
    assert.equal(results[0].metadata.id, 'ml');
  });

  it('custom weights produce different score distributions', () => {
    // Use candidates where vector and keyword signals differ clearly.
    // Doc A is semantically close to query (high cosine) but shares no keywords.
    // Doc B has exact keyword match but is semantically distant.
    const docA: ISearchCandidate = {
      text: 'alpha beta',
      // Manually set a vector almost identical to the query vector (high cosine).
      vector: [1, 0, 0],
      metadata: { id: 'docA' },
    };
    const docB: ISearchCandidate = {
      text: 'gamma gamma gamma',
      // Semantically distant from query.
      vector: [0, 0, 1],
      metadata: { id: 'docB' },
    };

    const localCandidates = [docA, docB];
    const localContext = makeContext(localCandidates);

    // Query: vector aligned with docA, text aligned with docB via keyword match
    const query = { text: 'gamma', vector: [1, 0, 0] as number[] };

    const vectorOnly = new WeightedFusionStrategy({
      vectorWeight: 1,
      keywordWeight: 0,
    });
    const keywordOnly = new WeightedFusionStrategy({
      vectorWeight: 0,
      keywordWeight: 1,
    });

    const vectorResults = vectorOnly.score(
      query,
      localCandidates,
      localContext,
    );
    const keywordResults = keywordOnly.score(
      query,
      localCandidates,
      localContext,
    );

    // Pure vector: docA should win (vector aligned)
    assert.equal(
      vectorResults[0].metadata.id,
      'docA',
      'vectorWeight=1 should rank docA first',
    );

    // Pure keyword: docB should win (has keyword "gamma" from query)
    assert.equal(
      keywordResults[0].metadata.id,
      'docB',
      'keywordWeight=1 should rank docB first',
    );
  });
});

describe('RrfStrategy', () => {
  it('name equals rrf', () => {
    const strategy = new RrfStrategy();
    assert.equal(strategy.name, 'rrf');
  });

  it('scores using reciprocal rank fusion, results sorted desc, all scores > 0', () => {
    const strategy = new RrfStrategy();
    const context = makeContext(CANDIDATES);
    const queryText = 'machine learning';
    const results = strategy.score(
      { text: queryText, vector: tfVector(queryText, VOCAB) },
      CANDIDATES,
      context,
    );

    assert.equal(results.length, CANDIDATES.length);
    for (let i = 0; i < results.length - 1; i++) {
      assert.ok(
        results[i].score >= results[i + 1].score,
        `Result ${i} score (${results[i].score}) should be >= result ${i + 1} score (${results[i + 1].score})`,
      );
    }
    for (const r of results) {
      assert.ok(r.score > 0, `Score should be > 0, got ${r.score}`);
    }
  });

  it('rank-based: scaled vectors give same ranking and same RRF scores', () => {
    const strategy = new RrfStrategy();
    const context = makeContext(CANDIDATES);
    const queryText = 'machine learning';
    const queryVector = tfVector(queryText, VOCAB);

    // Scale all candidate vectors by 100
    const scaledCandidates: ISearchCandidate[] = CANDIDATES.map((c) => ({
      ...c,
      vector: c.vector.map((v) => v * 100),
    }));
    const scaledQuery = {
      text: queryText,
      vector: queryVector.map((v) => v * 100),
    };

    const normal = strategy.score(
      { text: queryText, vector: queryVector },
      CANDIDATES,
      context,
    );
    const scaled = strategy.score(scaledQuery, scaledCandidates, context);

    assert.equal(normal.length, scaled.length);
    for (let i = 0; i < normal.length; i++) {
      assert.equal(
        normal[i].metadata.id,
        scaled[i].metadata.id,
        `Rankings should be identical at position ${i}`,
      );
      assert.ok(
        Math.abs(normal[i].score - scaled[i].score) < 1e-10,
        `RRF scores should be identical: normal=${normal[i].score}, scaled=${scaled[i].score}`,
      );
    }
  });

  it('custom k: k=1 gives higher absolute scores than k=60 but same ranking', () => {
    const strategyDefault = new RrfStrategy({ k: 60 });
    const strategyLowK = new RrfStrategy({ k: 1 });
    const context = makeContext(CANDIDATES);
    const queryText = 'machine learning';
    const queryVector = tfVector(queryText, VOCAB);

    const defaultResults = strategyDefault.score(
      { text: queryText, vector: queryVector },
      CANDIDATES,
      context,
    );
    const lowKResults = strategyLowK.score(
      { text: queryText, vector: queryVector },
      CANDIDATES,
      context,
    );

    // k=1 produces higher scores (smaller denominator → larger 1/(k+rank))
    for (let i = 0; i < defaultResults.length; i++) {
      assert.ok(
        lowKResults[i].score > defaultResults[i].score,
        `k=1 score (${lowKResults[i].score}) should be > k=60 score (${defaultResults[i].score}) at position ${i}`,
      );
    }

    // Rankings should be the same
    for (let i = 0; i < defaultResults.length; i++) {
      assert.equal(
        defaultResults[i].metadata.id,
        lowKResults[i].metadata.id,
        `Rankings should match at position ${i}`,
      );
    }
  });
});
