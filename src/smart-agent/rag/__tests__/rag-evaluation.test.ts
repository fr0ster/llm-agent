import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IEmbedder, IEmbedResult } from '../../interfaces/rag.js';
import type { CallOptions, RagResult } from '../../interfaces/types.js';
import { InMemoryRag } from '../in-memory-rag.js';
import { QueryEmbedding, TextOnlyEmbedding } from '../query-embedding.js';
import {
  Bm25OnlyStrategy,
  RrfStrategy,
  VectorOnlyStrategy,
} from '../search-strategy.js';
import { VectorRag } from '../vector-rag.js';

// ---------------------------------------------------------------------------
// Golden corpus
// ---------------------------------------------------------------------------

interface CorpusEntry {
  text: string;
  id: string;
}

const GOLDEN_CORPUS: CorpusEntry[] = [
  // Tool descriptions
  {
    id: 'tool:abap_get_object_source',
    text: 'Get ABAP source code of an object such as a class, program, or function module. Retrieves the full source listing from the repository.',
  },
  {
    id: 'tool:abap_run_ats_check',
    text: 'Run ATC (ABAP Test Cockpit) static analysis checks on an ABAP object. Returns findings, priorities, and message details.',
  },
  {
    id: 'tool:abap_create_transport',
    text: 'Create a new transport request in the system. Specify description, type (workbench or customizing), and target.',
  },
  {
    id: 'tool:abap_search_object',
    text: 'Search for ABAP objects by name, type, or package. Supports wildcards and returns a list of matching repository objects.',
  },
  {
    id: 'tool:abap_release_transport',
    text: 'Release a transport request so it can be imported into the target system. Validates objects and locks before release.',
  },
  {
    id: 'tool:abap_get_class_info',
    text: 'Get detailed information about an ABAP class including its methods, attributes, interfaces, and inheritance hierarchy.',
  },
  // System facts
  {
    id: 'fact:cds_views',
    text: 'CDS views are the standard data model in S/4HANA. They provide a semantic layer on top of database tables using annotations and associations.',
  },
  {
    id: 'fact:rfc_modules',
    text: 'RFC modules expose remote-callable function modules. They allow external systems to invoke ABAP logic over the RFC protocol.',
  },
  {
    id: 'fact:badi_framework',
    text: 'BAdI (Business Add-In) is the standard enhancement framework in SAP. It allows modifying standard behavior without modifying original code.',
  },
  {
    id: 'fact:abap_packages',
    text: 'ABAP packages organize development objects into logical units. Package checks enforce dependency rules between software components.',
  },
  // Feedback
  {
    id: 'feedback:search_exact_name',
    text: 'Previous search returned wrong package — use exact class name instead of wildcard patterns for precise results.',
  },
  {
    id: 'feedback:transport_lock',
    text: 'Transport release failed because objects were locked by another user. Check lock entries before attempting release.',
  },
  // State
  {
    id: 'state:current_system',
    text: 'Current system S4H client 100, user DEVELOPER. Connected to development landscape.',
  },
  {
    id: 'state:active_transport',
    text: 'Active transport request S4HK900001 with 3 objects assigned. Status: modifiable.',
  },
  {
    id: 'state:last_atc_run',
    text: 'Last ATC run on ZCL_MY_CLASS found 2 priority-1 findings and 5 priority-2 findings.',
  },
];

// ---------------------------------------------------------------------------
// Golden queries with expected results
// ---------------------------------------------------------------------------

interface GoldenQuery {
  query: string;
  expectedTopIds: string[];
  k: number;
}

const GOLDEN_QUERIES: GoldenQuery[] = [
  {
    query: 'get ABAP source code of a class',
    expectedTopIds: ['tool:abap_get_object_source'],
    k: 3,
  },
  {
    query: 'run ATC static analysis checks',
    expectedTopIds: ['tool:abap_run_ats_check'],
    k: 3,
  },
  {
    query: 'create a new transport request',
    expectedTopIds: ['tool:abap_create_transport'],
    k: 3,
  },
  {
    query: 'search for ABAP objects by name',
    expectedTopIds: ['tool:abap_search_object'],
    k: 3,
  },
  {
    query: 'release transport to production',
    expectedTopIds: ['tool:abap_release_transport'],
    k: 3,
  },
  {
    query: 'CDS view data model S/4HANA',
    expectedTopIds: ['fact:cds_views'],
    k: 5,
  },
  {
    query: 'RFC function module remote call',
    expectedTopIds: ['fact:rfc_modules'],
    k: 5,
  },
  {
    query: 'find class info and methods',
    expectedTopIds: ['tool:abap_get_class_info'],
    k: 3,
  },
];

// ---------------------------------------------------------------------------
// Metric helpers
// ---------------------------------------------------------------------------

function precision(results: RagResult[], expectedIds: string[]): number {
  if (results.length === 0) return 0;
  const hits = results.filter((r) =>
    expectedIds.includes(r.metadata.id as string),
  );
  return hits.length / results.length;
}

function reciprocalRank(results: RagResult[], expectedIds: string[]): number {
  for (let i = 0; i < results.length; i++) {
    if (expectedIds.includes(results[i].metadata.id as string)) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

function recall(results: RagResult[], expectedIds: string[]): number {
  if (expectedIds.length === 0) return 1;
  const found = expectedIds.filter((id) =>
    results.some((r) => r.metadata.id === id),
  );
  return found.length / expectedIds.length;
}

// ---------------------------------------------------------------------------
// TF bag-of-words embedder for VectorRag (deterministic, no network)
// ---------------------------------------------------------------------------

class TfEmbedder implements IEmbedder {
  private vocabulary: string[] = [];

  buildVocabulary(texts: string[]): void {
    const allTokens = new Set<string>();
    for (const text of texts) {
      for (const token of this.tokenize(text)) {
        allTokens.add(token);
      }
    }
    this.vocabulary = [...allTokens].sort();
  }

  async embed(_text: string, _options?: CallOptions): Promise<IEmbedResult> {
    const tokens = this.tokenize(_text);
    const freq = new Map<string, number>();
    for (const t of tokens) freq.set(t, (freq.get(t) ?? 0) + 1);

    const vec = this.vocabulary.map((term) => freq.get(term) ?? 0);

    // L2-normalize
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    if (norm > 0) {
      for (let i = 0; i < vec.length; i++) vec[i] /= norm;
    }

    return { vector: vec };
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 1);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function seedRag(
  rag: InMemoryRag | VectorRag,
  corpus: CorpusEntry[],
): Promise<void> {
  for (const entry of corpus) {
    const result = await rag.upsert(entry.text, { id: entry.id });
    assert.ok(result.ok, `Failed to upsert corpus entry ${entry.id}`);
  }
}

async function runQuery(
  rag: InMemoryRag | VectorRag,
  query: string,
  k: number,
  embedder?: IEmbedder,
): Promise<RagResult[]> {
  const embedding = embedder
    ? new QueryEmbedding(query, embedder)
    : new TextOnlyEmbedding(query);
  const result = await rag.query(embedding, k);
  assert.ok(result.ok, `Query failed for: ${query}`);
  return result.value;
}

// ---------------------------------------------------------------------------
// Tests — InMemoryRag
// ---------------------------------------------------------------------------

describe('RAG Evaluation — InMemoryRag', () => {
  it('all golden queries return expected tool in top-k', async () => {
    const rag = new InMemoryRag({ dedupThreshold: 0.99 });
    await seedRag(rag, GOLDEN_CORPUS);

    for (const gq of GOLDEN_QUERIES) {
      const results = await runQuery(rag, gq.query, gq.k);
      const topIds = results.map((r) => r.metadata.id);
      for (const expectedId of gq.expectedTopIds) {
        assert.ok(
          topIds.includes(expectedId),
          `Query "${gq.query}": expected "${expectedId}" in top-${gq.k}, got [${topIds.join(', ')}]`,
        );
      }
    }
  });

  it('MRR >= 0.7 across all golden queries', async () => {
    const rag = new InMemoryRag({ dedupThreshold: 0.99 });
    await seedRag(rag, GOLDEN_CORPUS);

    let totalRR = 0;
    for (const gq of GOLDEN_QUERIES) {
      const results = await runQuery(rag, gq.query, gq.k);
      totalRR += reciprocalRank(results, gq.expectedTopIds);
    }
    const mrr = totalRR / GOLDEN_QUERIES.length;
    assert.ok(mrr >= 0.7, `MRR = ${mrr.toFixed(3)}, expected >= 0.7`);
  });

  it('top-1 precision for tool lookups >= 80%', async () => {
    const rag = new InMemoryRag({ dedupThreshold: 0.99 });
    await seedRag(rag, GOLDEN_CORPUS);

    const toolQueries = GOLDEN_QUERIES.filter((gq) =>
      gq.expectedTopIds.some((id) => id.startsWith('tool:')),
    );
    let totalP1 = 0;
    for (const gq of toolQueries) {
      const results = await runQuery(rag, gq.query, 1);
      totalP1 += precision(results, gq.expectedTopIds);
    }
    const avgP1 = totalP1 / toolQueries.length;
    assert.ok(
      avgP1 >= 0.8,
      `Top-1 precision = ${(avgP1 * 100).toFixed(1)}%, expected >= 80%`,
    );
  });

  it('recall = 1.0 for all golden queries at their specified k', async () => {
    const rag = new InMemoryRag({ dedupThreshold: 0.99 });
    await seedRag(rag, GOLDEN_CORPUS);

    for (const gq of GOLDEN_QUERIES) {
      const results = await runQuery(rag, gq.query, gq.k);
      const r = recall(results, gq.expectedTopIds);
      assert.equal(r, 1.0, `Query "${gq.query}": recall = ${r}, expected 1.0`);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests — VectorRag (hybrid)
// ---------------------------------------------------------------------------

describe('RAG Evaluation — VectorRag (hybrid)', () => {
  function createVectorRag(): { rag: VectorRag; embedder: TfEmbedder } {
    const embedder = new TfEmbedder();
    // Build vocabulary from corpus + queries so embedding dimensions are stable
    const allTexts = [
      ...GOLDEN_CORPUS.map((e) => e.text),
      ...GOLDEN_QUERIES.map((q) => q.query),
    ];
    embedder.buildVocabulary(allTexts);
    const rag = new VectorRag(embedder, { dedupThreshold: 0.99 });
    return { rag, embedder };
  }

  it('all golden queries return expected tool in top-k', async () => {
    const { rag, embedder } = createVectorRag();
    await seedRag(rag, GOLDEN_CORPUS);

    for (const gq of GOLDEN_QUERIES) {
      const results = await runQuery(rag, gq.query, gq.k, embedder);
      const topIds = results.map((r) => r.metadata.id);
      for (const expectedId of gq.expectedTopIds) {
        assert.ok(
          topIds.includes(expectedId),
          `Query "${gq.query}": expected "${expectedId}" in top-${gq.k}, got [${topIds.join(', ')}]`,
        );
      }
    }
  });

  it('MRR >= 0.7 across all golden queries', async () => {
    const { rag, embedder } = createVectorRag();
    await seedRag(rag, GOLDEN_CORPUS);

    let totalRR = 0;
    for (const gq of GOLDEN_QUERIES) {
      const results = await runQuery(rag, gq.query, gq.k, embedder);
      totalRR += reciprocalRank(results, gq.expectedTopIds);
    }
    const mrr = totalRR / GOLDEN_QUERIES.length;
    assert.ok(mrr >= 0.7, `MRR = ${mrr.toFixed(3)}, expected >= 0.7`);
  });

  it('BM25 component boosts exact-term matches', async () => {
    const { rag, embedder } = createVectorRag();
    await seedRag(rag, GOLDEN_CORPUS);

    // Query with exact tool-related term should rank the matching tool higher
    const exactResult = await runQuery(
      rag,
      'abap_get_object_source',
      3,
      embedder,
    );
    const synonymResult = await runQuery(
      rag,
      'retrieve program listing',
      3,
      embedder,
    );

    const exactTopId = exactResult[0]?.metadata.id;

    // Exact query must return the right tool as #1
    assert.equal(
      exactTopId,
      'tool:abap_get_object_source',
      `Exact query top-1 should be tool:abap_get_object_source, got ${exactTopId}`,
    );

    // Exact query score should be higher than synonym query score for the same doc
    const exactScore =
      exactResult.find((r) => r.metadata.id === 'tool:abap_get_object_source')
        ?.score ?? 0;
    const synonymScore =
      synonymResult.find((r) => r.metadata.id === 'tool:abap_get_object_source')
        ?.score ?? 0;

    assert.ok(
      exactScore > synonymScore,
      `Exact-term score (${exactScore.toFixed(3)}) should exceed synonym score (${synonymScore.toFixed(3)})`,
    );
  });
});

// ---------------------------------------------------------------------------
// Tests — VectorRag (RRF)
// ---------------------------------------------------------------------------

describe('RAG Evaluation — VectorRag (RRF)', () => {
  function createVectorRag(): { rag: VectorRag; embedder: TfEmbedder } {
    const embedder = new TfEmbedder();
    const allTexts = [
      ...GOLDEN_CORPUS.map((e) => e.text),
      ...GOLDEN_QUERIES.map((q) => q.query),
    ];
    embedder.buildVocabulary(allTexts);
    const rag = new VectorRag(embedder, {
      dedupThreshold: 0.99,
      strategy: new RrfStrategy(),
    });
    return { rag, embedder };
  }

  it('all golden queries return expected tool in top-k', async () => {
    const { rag, embedder } = createVectorRag();
    await seedRag(rag, GOLDEN_CORPUS);

    for (const gq of GOLDEN_QUERIES) {
      const results = await runQuery(rag, gq.query, gq.k, embedder);
      const topIds = results.map((r) => r.metadata.id);
      for (const expectedId of gq.expectedTopIds) {
        assert.ok(
          topIds.includes(expectedId),
          `[RRF] Query "${gq.query}": expected "${expectedId}" in top-${gq.k}, got [${topIds.join(', ')}]`,
        );
      }
    }
  });

  it('MRR >= 0.7 across all golden queries', async () => {
    const { rag, embedder } = createVectorRag();
    await seedRag(rag, GOLDEN_CORPUS);

    let totalRR = 0;
    for (const gq of GOLDEN_QUERIES) {
      const results = await runQuery(rag, gq.query, gq.k, embedder);
      totalRR += reciprocalRank(results, gq.expectedTopIds);
    }
    const mrr = totalRR / GOLDEN_QUERIES.length;
    assert.ok(mrr >= 0.7, `[RRF] MRR = ${mrr.toFixed(3)}, expected >= 0.7`);
  });
});

// ---------------------------------------------------------------------------
// Tests — VectorRag (vector-only)
// ---------------------------------------------------------------------------

describe('RAG Evaluation — VectorRag (vector-only)', () => {
  function createVectorRag(): { rag: VectorRag; embedder: TfEmbedder } {
    const embedder = new TfEmbedder();
    const allTexts = [
      ...GOLDEN_CORPUS.map((e) => e.text),
      ...GOLDEN_QUERIES.map((q) => q.query),
    ];
    embedder.buildVocabulary(allTexts);
    const rag = new VectorRag(embedder, {
      dedupThreshold: 0.99,
      strategy: new VectorOnlyStrategy(),
    });
    return { rag, embedder };
  }

  it('all golden queries return expected tool in top-k', async () => {
    const { rag, embedder } = createVectorRag();
    await seedRag(rag, GOLDEN_CORPUS);

    for (const gq of GOLDEN_QUERIES) {
      const results = await runQuery(rag, gq.query, gq.k, embedder);
      const topIds = results.map((r) => r.metadata.id);
      for (const expectedId of gq.expectedTopIds) {
        assert.ok(
          topIds.includes(expectedId),
          `[Vector-only] Query "${gq.query}": expected "${expectedId}" in top-${gq.k}, got [${topIds.join(', ')}]`,
        );
      }
    }
  });

  it('MRR >= 0.5 across all golden queries', async () => {
    const { rag, embedder } = createVectorRag();
    await seedRag(rag, GOLDEN_CORPUS);

    let totalRR = 0;
    for (const gq of GOLDEN_QUERIES) {
      const results = await runQuery(rag, gq.query, gq.k, embedder);
      totalRR += reciprocalRank(results, gq.expectedTopIds);
    }
    const mrr = totalRR / GOLDEN_QUERIES.length;
    assert.ok(
      mrr >= 0.5,
      `[Vector-only] MRR = ${mrr.toFixed(3)}, expected >= 0.5`,
    );
  });
});

// ---------------------------------------------------------------------------
// Tests — VectorRag (BM25-only)
// ---------------------------------------------------------------------------

describe('RAG Evaluation — VectorRag (BM25-only)', () => {
  function createVectorRag(): { rag: VectorRag; embedder: TfEmbedder } {
    const embedder = new TfEmbedder();
    const allTexts = [
      ...GOLDEN_CORPUS.map((e) => e.text),
      ...GOLDEN_QUERIES.map((q) => q.query),
    ];
    embedder.buildVocabulary(allTexts);
    const rag = new VectorRag(embedder, {
      dedupThreshold: 0.99,
      strategy: new Bm25OnlyStrategy(),
    });
    return { rag, embedder };
  }

  it('all golden queries return expected tool in top-k', async () => {
    const { rag, embedder } = createVectorRag();
    await seedRag(rag, GOLDEN_CORPUS);

    for (const gq of GOLDEN_QUERIES) {
      const results = await runQuery(rag, gq.query, gq.k, embedder);
      const topIds = results.map((r) => r.metadata.id);
      for (const expectedId of gq.expectedTopIds) {
        assert.ok(
          topIds.includes(expectedId),
          `[BM25-only] Query "${gq.query}": expected "${expectedId}" in top-${gq.k}, got [${topIds.join(', ')}]`,
        );
      }
    }
  });

  it('MRR >= 0.5 across all golden queries', async () => {
    const { rag, embedder } = createVectorRag();
    await seedRag(rag, GOLDEN_CORPUS);

    let totalRR = 0;
    for (const gq of GOLDEN_QUERIES) {
      const results = await runQuery(rag, gq.query, gq.k, embedder);
      totalRR += reciprocalRank(results, gq.expectedTopIds);
    }
    const mrr = totalRR / GOLDEN_QUERIES.length;
    assert.ok(
      mrr >= 0.5,
      `[BM25-only] MRR = ${mrr.toFixed(3)}, expected >= 0.5`,
    );
  });
});
