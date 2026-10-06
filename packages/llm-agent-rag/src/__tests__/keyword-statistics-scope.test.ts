import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IEmbedder } from '@mcp-abap-adt/llm-agent';
import { symmetricEmbedder } from '@mcp-abap-adt/llm-agent';
import { conformanceEmbedder } from '@mcp-abap-adt/llm-agent/testing/rag-filter-conformance';
import { InvertedIndex } from '../inverted-index.js';
import {
  Bm25OnlyStrategy,
  CompositeStrategy,
  type ISearchCandidate,
  type ISearchContext,
  type ISearchStrategy,
  RrfStrategy,
  VectorOnlyStrategy,
  WeightedFusionStrategy,
} from '../search-strategy.js';
import { VectorRag } from '../vector-rag.js';

// BM25's document frequency, document count and average length must come
// from the records the query may see (its candidates, after the namespace /
// TTL / session / user filters), never from the whole store: otherwise one
// session's ranking depends on — and leaks a signal about — another session's
// records.

const embedder: IEmbedder = conformanceEmbedder();
const Q = 'transport release request';

async function scoresFor(rag: VectorRag, sessionId: string) {
  const res = await rag.query(
    { text: Q, toVector: async () => (await embedder.embed(Q)).vector },
    10,
    { ragFilter: { sessionId } },
  );
  if (!res.ok) throw res.error;
  return res.value.map((r) => ({ id: r.metadata.id, score: r.score }));
}

const S1 = [
  { id: 's1-a', text: 'release the transport request after review' },
  { id: 's1-b', text: 'create a transport for the package' },
  { id: 's1-c', text: 'read the class source code and its includes' },
  { id: 's1-d', text: 'request a lock on the program before editing' },
];

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]/)
    .filter((t) => t.length > 1);
}

describe('VectorRag keyword statistics are scoped to the query candidates', () => {
  it("another session's records do not change this session's scores or order", async () => {
    const rag = new VectorRag(symmetricEmbedder(embedder));
    const w = rag.writer();
    for (const r of S1) await w.upsertRaw(r.id, r.text, { sessionId: 's1' });
    const before = await scoresFor(rag, 's1');

    // Many s2 records that all contain the query terms: store-wide statistics
    // would drop the IDF of "transport"/"release"/"request" and grow the
    // average document length.
    for (let i = 0; i < 40; i++) {
      await w.upsertRaw(
        `s2-${i}`,
        `transport release request number ${i} with a much longer body of padding words ${'pad '.repeat(i % 7)}`,
        { sessionId: 's2' },
      );
    }
    const after = await scoresFor(rag, 's1');
    assert.deepEqual(after, before);
  });
});

describe('every built-in strategy ignores statistics beyond its candidates', () => {
  const vec = async (t: string) => (await embedder.embed(t)).vector;

  async function candidates(): Promise<ISearchCandidate[]> {
    return Promise.all(
      S1.map(async (r) => ({
        text: r.text,
        vector: await vec(r.text),
        metadata: { id: r.id },
      })),
    );
  }

  function contextOver(texts: string[]): ISearchContext {
    const index = new InvertedIndex();
    texts.forEach((t, i) => {
      index.add(i, tokenize(t));
    });
    return { index, tokenize };
  }

  const strategies: ISearchStrategy[] = [
    new WeightedFusionStrategy(),
    new RrfStrategy(),
    new Bm25OnlyStrategy(),
    new VectorOnlyStrategy(),
    new CompositeStrategy([
      { strategy: new VectorOnlyStrategy(), weight: 1 },
      { strategy: new Bm25OnlyStrategy(), weight: 1 },
    ]),
  ];

  for (const strategy of strategies) {
    it(`${strategy.name}: a store-wide index gives the same result as the candidates' own`, async () => {
      const cands = await candidates();
      const query = { text: Q, vector: await vec(Q) };
      const own = strategy.score(
        query,
        cands,
        contextOver(cands.map((c) => c.text)),
      );
      const polluted = strategy.score(
        query,
        cands,
        contextOver([
          ...cands.map((c) => c.text),
          ...Array.from(
            { length: 40 },
            (_, i) => `transport release request ${i} padding padding padding`,
          ),
        ]),
      );
      assert.deepEqual(polluted, own);
    });
  }
});
