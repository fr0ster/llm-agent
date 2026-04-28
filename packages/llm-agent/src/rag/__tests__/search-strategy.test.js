import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InvertedIndex } from '../inverted-index.js';
import { Bm25OnlyStrategy, CompositeStrategy, RrfStrategy, VectorOnlyStrategy, WeightedFusionStrategy, } from '../search-strategy.js';
// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------
function tokenize(s) {
    return s
        .toLowerCase()
        .split(/[^a-z0-9]/)
        .filter((t) => t.length > 1);
}
function tfVector(text, vocab) {
    const tokens = tokenize(text);
    const freq = new Map();
    for (const t of tokens)
        freq.set(t, (freq.get(t) ?? 0) + 1);
    const vec = vocab.map((term) => freq.get(term) ?? 0);
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    if (norm > 0)
        for (let i = 0; i < vec.length; i++)
            vec[i] /= norm;
    return vec;
}
function makeContext(candidates) {
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
const CANDIDATES = [
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
        const results = strategy.score({ text: queryText, vector: tfVector(queryText, vocab) }, candidates, context);
        assert.equal(results.length, candidates.length);
        for (let i = 0; i < results.length - 1; i++) {
            assert.ok(results[i].score >= results[i + 1].score, `Result ${i} score (${results[i].score}) should be >= result ${i + 1} score (${results[i + 1].score})`);
        }
    });
    it('top result is the most relevant candidate for a known query', () => {
        const strategy = new WeightedFusionStrategy();
        const context = makeContext(candidates);
        const queryText = 'machine learning neural';
        const results = strategy.score({ text: queryText, vector: tfVector(queryText, vocab) }, candidates, context);
        // The ML candidate matches best for "machine learning neural" query
        assert.equal(results[0].metadata.id, 'ml');
    });
    it('custom weights produce different score distributions', () => {
        // Use candidates where vector and keyword signals differ clearly.
        // Doc A is semantically close to query (high cosine) but shares no keywords.
        // Doc B has exact keyword match but is semantically distant.
        const docA = {
            text: 'alpha beta',
            // Manually set a vector almost identical to the query vector (high cosine).
            vector: [1, 0, 0],
            metadata: { id: 'docA' },
        };
        const docB = {
            text: 'gamma gamma gamma',
            // Semantically distant from query.
            vector: [0, 0, 1],
            metadata: { id: 'docB' },
        };
        const localCandidates = [docA, docB];
        const localContext = makeContext(localCandidates);
        // Query: vector aligned with docA, text aligned with docB via keyword match
        const query = { text: 'gamma', vector: [1, 0, 0] };
        const vectorOnly = new WeightedFusionStrategy({
            vectorWeight: 1,
            keywordWeight: 0,
        });
        const keywordOnly = new WeightedFusionStrategy({
            vectorWeight: 0,
            keywordWeight: 1,
        });
        const vectorResults = vectorOnly.score(query, localCandidates, localContext);
        const keywordResults = keywordOnly.score(query, localCandidates, localContext);
        // Pure vector: docA should win (vector aligned)
        assert.equal(vectorResults[0].metadata.id, 'docA', 'vectorWeight=1 should rank docA first');
        // Pure keyword: docB should win (has keyword "gamma" from query)
        assert.equal(keywordResults[0].metadata.id, 'docB', 'keywordWeight=1 should rank docB first');
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
        const results = strategy.score({ text: queryText, vector: tfVector(queryText, VOCAB) }, CANDIDATES, context);
        assert.equal(results.length, CANDIDATES.length);
        for (let i = 0; i < results.length - 1; i++) {
            assert.ok(results[i].score >= results[i + 1].score, `Result ${i} score (${results[i].score}) should be >= result ${i + 1} score (${results[i + 1].score})`);
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
        const scaledCandidates = CANDIDATES.map((c) => ({
            ...c,
            vector: c.vector.map((v) => v * 100),
        }));
        const scaledQuery = {
            text: queryText,
            vector: queryVector.map((v) => v * 100),
        };
        const normal = strategy.score({ text: queryText, vector: queryVector }, CANDIDATES, context);
        const scaled = strategy.score(scaledQuery, scaledCandidates, context);
        assert.equal(normal.length, scaled.length);
        for (let i = 0; i < normal.length; i++) {
            assert.equal(normal[i].metadata.id, scaled[i].metadata.id, `Rankings should be identical at position ${i}`);
            assert.ok(Math.abs(normal[i].score - scaled[i].score) < 1e-10, `RRF scores should be identical: normal=${normal[i].score}, scaled=${scaled[i].score}`);
        }
    });
    it('custom k: k=1 gives higher absolute scores than k=60 but same ranking', () => {
        const strategyDefault = new RrfStrategy({ k: 60 });
        const strategyLowK = new RrfStrategy({ k: 1 });
        const context = makeContext(CANDIDATES);
        const queryText = 'machine learning';
        const queryVector = tfVector(queryText, VOCAB);
        const defaultResults = strategyDefault.score({ text: queryText, vector: queryVector }, CANDIDATES, context);
        const lowKResults = strategyLowK.score({ text: queryText, vector: queryVector }, CANDIDATES, context);
        // k=1 produces higher scores (smaller denominator → larger 1/(k+rank))
        for (let i = 0; i < defaultResults.length; i++) {
            assert.ok(lowKResults[i].score > defaultResults[i].score, `k=1 score (${lowKResults[i].score}) should be > k=60 score (${defaultResults[i].score}) at position ${i}`);
        }
        // Rankings should be the same
        for (let i = 0; i < defaultResults.length; i++) {
            assert.equal(defaultResults[i].metadata.id, lowKResults[i].metadata.id, `Rankings should match at position ${i}`);
        }
    });
});
describe('VectorOnlyStrategy', () => {
    it('name equals vector-only', () => {
        const strategy = new VectorOnlyStrategy();
        assert.equal(strategy.name, 'vector-only');
    });
    it('scores using cosine similarity only, returns sorted desc, top result correct', () => {
        const strategy = new VectorOnlyStrategy();
        const context = makeContext(CANDIDATES);
        const queryText = 'machine learning neural';
        const results = strategy.score({ text: queryText, vector: tfVector(queryText, VOCAB) }, CANDIDATES, context);
        assert.equal(results.length, CANDIDATES.length);
        for (let i = 0; i < results.length - 1; i++) {
            assert.ok(results[i].score >= results[i + 1].score, `Result ${i} score (${results[i].score}) should be >= result ${i + 1} score (${results[i + 1].score})`);
        }
        // The ML candidate has the highest cosine similarity for this query
        assert.equal(results[0].metadata.id, 'ml');
    });
    it('ignores BM25: when query text says "create transport" but vector points to source code, vector wins', () => {
        const strategy = new VectorOnlyStrategy();
        // source_code has a vector closely aligned to [1, 0, 0]
        const sourceCode = {
            text: 'source code implementation details',
            vector: [1, 0, 0],
            metadata: { id: 'source_code' },
        };
        // transport_release has many keyword matches for "create transport" but a distant vector
        const transportRelease = {
            text: 'create transport release',
            vector: [0, 0, 1],
            metadata: { id: 'transport_release' },
        };
        const localCandidates = [sourceCode, transportRelease];
        const localContext = makeContext(localCandidates);
        // Query text says "create transport" but vector points toward sourceCode
        const results = strategy.score({ text: 'create transport', vector: [1, 0, 0] }, localCandidates, localContext);
        // Vector wins: sourceCode should rank first despite keyword mismatch
        assert.equal(results[0].metadata.id, 'source_code');
    });
});
describe('Bm25OnlyStrategy', () => {
    it('name equals bm25-only', () => {
        const strategy = new Bm25OnlyStrategy();
        assert.equal(strategy.name, 'bm25-only');
    });
    it('scores using BM25 only; for query "transport release" the release_transport tool ranks first', () => {
        const strategy = new Bm25OnlyStrategy();
        const transportRelease = {
            text: 'release transport request',
            vector: [0, 0, 1],
            metadata: { id: 'release_transport' },
        };
        const machineDoc = {
            text: 'machine learning integration',
            vector: [1, 0, 0],
            metadata: { id: 'machine_doc' },
        };
        const localCandidates = [machineDoc, transportRelease];
        const localContext = makeContext(localCandidates);
        // "transport release" keywords match transportRelease, not machineDoc
        const results = strategy.score({ text: 'transport release', vector: [] }, localCandidates, localContext);
        assert.equal(results[0].metadata.id, 'release_transport');
    });
    it('works with empty vector (vector field = [])', () => {
        const strategy = new Bm25OnlyStrategy();
        const context = makeContext(CANDIDATES);
        const queryText = 'machine learning';
        // empty vector should not throw
        const results = strategy.score({ text: queryText, vector: [] }, CANDIDATES, context);
        assert.equal(results.length, CANDIDATES.length);
        for (let i = 0; i < results.length - 1; i++) {
            assert.ok(results[i].score >= results[i + 1].score, `Result ${i} score (${results[i].score}) should be >= result ${i + 1} score (${results[i + 1].score})`);
        }
    });
});
describe('CompositeStrategy', () => {
    it('name includes child strategy names', () => {
        const strategy = new CompositeStrategy([
            { strategy: new VectorOnlyStrategy(), weight: 1.0 },
            { strategy: new Bm25OnlyStrategy(), weight: 0.5 },
        ]);
        assert.equal(strategy.name, 'composite(vector-only+bm25-only)');
    });
    it('combines child rankings with weighted RRF', () => {
        const strategy = new CompositeStrategy([
            { strategy: new VectorOnlyStrategy(), weight: 1.0 },
            { strategy: new Bm25OnlyStrategy(), weight: 1.0 },
        ]);
        const context = makeContext(CANDIDATES);
        const queryText = 'machine learning';
        const results = strategy.score({ text: queryText, vector: tfVector(queryText, VOCAB) }, CANDIDATES, context);
        assert.equal(results.length, CANDIDATES.length);
        for (let i = 0; i < results.length - 1; i++) {
            assert.ok(results[i].score >= results[i + 1].score);
        }
        // All scores > 0
        for (const r of results) {
            assert.ok(r.score > 0);
        }
    });
    it('higher weight gives more influence', () => {
        // Isolated candidates where vector and BM25 clearly disagree
        const cA = {
            text: 'alpha bravo charlie',
            vector: [1, 0, 0],
            metadata: { id: 'a' },
        };
        const cB = {
            text: 'delta echo foxtrot',
            vector: [0, 0, 1],
            metadata: { id: 'b' },
        };
        const local = [cA, cB];
        const ctx = makeContext(local);
        // Query: vector points to A, text matches B
        const query = { text: 'delta echo foxtrot', vector: [1, 0, 0] };
        const vectorHeavy = new CompositeStrategy([
            { strategy: new VectorOnlyStrategy(), weight: 10.0 },
            { strategy: new Bm25OnlyStrategy(), weight: 0.1 },
        ]);
        const bm25Heavy = new CompositeStrategy([
            { strategy: new VectorOnlyStrategy(), weight: 0.1 },
            { strategy: new Bm25OnlyStrategy(), weight: 10.0 },
        ]);
        const vResults = vectorHeavy.score(query, local, ctx);
        const bResults = bm25Heavy.score(query, local, ctx);
        // Vector-heavy: A wins (vector match)
        assert.equal(vResults[0].metadata.id, 'a');
        // BM25-heavy: B wins (keyword match)
        assert.equal(bResults[0].metadata.id, 'b');
    });
    it('handles empty candidates', () => {
        const strategy = new CompositeStrategy([
            { strategy: new RrfStrategy(), weight: 1.0 },
        ]);
        const context = makeContext([]);
        const results = strategy.score({ text: 'test', vector: [] }, [], context);
        assert.deepEqual(results, []);
    });
    it('deduplicates by id — keeps best score', () => {
        // Two candidates with same id but different text/vectors
        const dupes = [
            {
                text: 'machine learning neural',
                vector: tfVector('machine learning neural', VOCAB),
                metadata: { id: 'tool:X' },
            },
            {
                text: 'database sql query',
                vector: tfVector('database sql query', VOCAB),
                metadata: { id: 'tool:X' },
            },
            {
                text: 'other tool',
                vector: tfVector('other tool', VOCAB),
                metadata: { id: 'tool:Y' },
            },
        ];
        const strategy = new CompositeStrategy([
            { strategy: new VectorOnlyStrategy(), weight: 1.0 },
        ]);
        const context = makeContext(dupes);
        const results = strategy.score({ text: 'machine learning', vector: tfVector('machine learning', VOCAB) }, dupes, context);
        // Should have 2 results (deduped), not 3
        const ids = results.map((r) => r.metadata.id);
        assert.equal(ids.filter((id) => id === 'tool:X').length, 1);
        assert.equal(results.length, 2);
    });
});
//# sourceMappingURL=search-strategy.test.js.map