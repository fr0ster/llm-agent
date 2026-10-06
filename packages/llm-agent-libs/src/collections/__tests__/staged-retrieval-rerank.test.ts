// packages/llm-agent-libs/src/collections/__tests__/staged-retrieval-rerank.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type CallOptions,
  type IItemCut,
  type IProbabilityDecision,
  type IRag,
  type IRelevanceDecision,
  type IReranker,
  RagError,
  type RagResult,
  recordId,
} from '@mcp-abap-adt/llm-agent';
import { InMemoryRag } from '@mcp-abap-adt/llm-agent-rag';
import {
  ProbabilityReranker,
  RelevanceReranker,
} from '@mcp-abap-adt/llm-agent-reranker';
import {
  checkRerankOutput,
  ItemPool,
  MaxScoreCollapse,
  ScoreFloorCut,
  StagedRetrieval,
  type StagedRetrievalOptions,
} from '../index.js';
import {
  G,
  ids,
  matchesOnly,
  put,
  q,
  scored,
} from './staged-retrieval-helpers.js';

function staged(
  rag: IRag,
  rerank: StagedRetrievalOptions['rerank'],
  cut?: IItemCut,
) {
  return new StagedRetrieval({
    name: 'test',
    storeKey: 'tools',
    pool: new ItemPool(10),
    maxRecordsPerItem: 3,
    canonicalKind: 'full',
    sources: {
      sources: async (options) => [{ name: 'primary', rag, options }],
    },
    collapse: new MaxScoreCollapse(),
    rerank,
    ...(cut ? { cut } : {}),
  });
}

/** A probability decision answering P(relevant) per passage text. */
function probabilityDecision(
  p: ReadonlyMap<string, number>,
): IProbabilityDecision {
  return {
    decide: async (req) => ({
      ok: true,
      value: {
        model: 'fake',
        answers: Object.fromEntries(
          Object.entries(req.questions).map(([k, qq]) => [
            k,
            {
              type: 'noul' as const,
              probability:
                p.get(
                  String(
                    (qq as { instructions: { passage: string } }).instructions
                      .passage,
                  ),
                ) ?? 0,
            },
          ]),
        ),
      },
    }),
  };
}

/** A relevance decision answering a score per passage text — not a probability. */
function relevanceDecision(s: ReadonlyMap<string, number>): IRelevanceDecision {
  return {
    score: async ({ passages }) => ({
      ok: true,
      value: {
        model: 'fake',
        scores: passages.map((text, index) => ({
          index,
          score: s.get(text) ?? 0,
        })),
      },
    }),
  };
}

/** Reranked scores by stage-1 rank: the stage-1 top gets the LOWEST, so a pinned item is visible. */
const RERANKED = {
  probability: [0.05, 0.9, 0.8],
  relevance: [-3.5, 9.25, 4.5],
} as const;
const floor = () =>
  new ScoreFloorCut({ minItems: 1, maxItems: 3, minScore: 0.5 });

/** Records what it was asked and answers via `answer`. */
function spy(answer: (c: RagResult[]) => RagResult[] | Error | 'throw') {
  const seen: Array<{ query: string; texts: string[] }> = [];
  const reranker: IReranker = {
    rerank: async (query, results) => {
      seen.push({ query, texts: results.map((r) => r.text) });
      const a = answer(results);
      if (a === 'throw') throw new Error('boom');
      if (a instanceof Error)
        return { ok: false, error: new RagError(a.message, 'RERANK_ERROR') };
      return { ok: true, value: a };
    },
  };
  return { reranker, seen };
}
const reversed = (c: RagResult[]) =>
  [...c].reverse().map((r, i) => ({ ...r, score: 1 - i / 10 }));

async function fixture() {
  const raw = new InMemoryRag();
  await put(raw, 'A', [
    ['full', 'alpha provider text'],
    ['summary', 'needle needle'],
  ]);
  await put(raw, 'B', [['full', 'bravo needle provider']]);
  await put(raw, 'C', [
    ['full', 'charlie provider'],
    ['parameters', 'needle own words'],
  ]);
  return matchesOnly(raw);
}

describe('StagedRetrieval — reranker', () => {
  it("reranks items on their provider text — never a non-canonical record's own text", async () => {
    const rag = await fixture();
    const { reranker, seen } = spy(reversed);
    const r = await staged(rag, { reranker }).retrieve(rag, q('needle'), 3);
    assert.equal(seen[0].query, 'needle');
    assert.deepEqual(
      new Set(seen[0].texts),
      new Set([
        'alpha provider text',
        'bravo needle provider',
        'charlie provider',
      ]),
    );
    for (const t of seen[0].texts) assert.doesNotMatch(t, /own words/);
    assert.ok(r.ok);
    assert.equal(r.value[0].score, 1);
  });

  it('a non-canonical hit without itemText: the canonical record is read for its text', async () => {
    const raw = new InMemoryRag();
    await put(raw, 'T', [['full', 'tango provider']]);
    await raw.writer().upsertRaw(recordId(G, 'T', 'summary', 0), 'needle', {
      itemId: 'T',
      recordKind: 'summary',
      visibility: 'global',
    });
    const rag = matchesOnly(raw);
    const { reranker, seen } = spy((c) => c);
    await staged(rag, { reranker }).retrieve(rag, q('needle'), 3);
    assert.deepEqual(seen[0].texts, ['tango provider']);
  });

  it('a reranker that drops a candidate is a RERANK_ERROR: returned, never the stage-1 order, and the step is logged (D71)', async () => {
    const rag = await fixture();
    const { reranker } = spy((c) => c.slice(1));
    const steps: Array<[string, unknown]> = [];
    const opts: CallOptions = {
      sessionLogger: { logStep: (n, d) => steps.push([n, d]) },
    };
    const r = await staged(rag, { reranker }).retrieve(
      rag,
      q('needle'),
      3,
      opts,
    );
    assert.ok(!r.ok && r.error.code === 'RERANK_ERROR');
    assert.equal(steps[0][0], 'retrieval_rerank_error');
    assert.deepEqual(Object.keys(steps[0][1] as object).sort(), [
      'code',
      'message',
      'store',
      'strategy',
    ]);
    assert.equal((steps[0][1] as { code: string }).code, 'RERANK_ERROR');
  });

  it('a reranker answering ok: false returns the RERANK_ERROR', async () => {
    const rag = await fixture();
    const { reranker } = spy(() => new Error('bad'));
    const r = await staged(rag, { reranker }).retrieve(rag, q('needle'), 3);
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.error.code === 'RERANK_ERROR');
  });

  it('a thrown reranker is a RERANK_ERROR — no stage-1 fallback (D71)', async () => {
    const rag = await fixture();
    const { reranker } = spy(() => 'throw');
    const r = await staged(rag, { reranker }).retrieve(rag, q('needle'), 3);
    assert.ok(!r.ok && r.error.code === 'RERANK_ERROR');
  });

  it('keepStage1Top: the stage-1 top-n first, reranked items fill the rest, counted inside k', async () => {
    const rag = await fixture();
    const stage1 = await staged(rag, undefined).retrieve(rag, q('needle'), 3);
    const { reranker } = spy(reversed);
    const r = await staged(rag, { reranker, keepStage1Top: 1 }).retrieve(
      rag,
      q('needle'),
      2,
    );
    assert.ok(stage1.ok && r.ok);
    assert.equal(r.value.length, 2);
    assert.equal(r.value[0].metadata.id, stage1.value[0].metadata.id);
  });

  for (const kind of ['probability', 'relevance'] as const) {
    it(`keepStage1Top: a pinned item carries its RERANKED score, never the embedding score (${kind})`, async () => {
      const rag = await fixture();
      const stage1 = await staged(rag, undefined).retrieve(rag, q('needle'), 3);
      assert.ok(stage1.ok && stage1.value.length === 3);
      const given = new Map(
        stage1.value.map((x, i) => [x.text, RERANKED[kind][i]] as const),
      );
      const reranker: IReranker =
        kind === 'probability'
          ? new ProbabilityReranker(probabilityDecision(given))
          : new RelevanceReranker(relevanceDecision(given));
      const r = await staged(rag, { reranker, keepStage1Top: 1 }).retrieve(
        rag,
        q('needle'),
        3,
      );
      assert.ok(r.ok && r.value.length === 3);
      assert.equal(
        r.value[0].metadata.id,
        stage1.value[0].metadata.id,
        'pinned first, though the reranker put it last',
      );
      for (const x of r.value)
        assert.equal(
          x.score,
          given.get(x.text),
          `${String(x.metadata.id)} carries its reranked score`,
        );
      assert.notEqual(
        r.value[0].score,
        stage1.value[0].score,
        'never the stage-1 (embedding) score',
      );
      assert.deepEqual(
        r.value.slice(1).map((x) => x.score),
        [...RERANKED[kind].slice(1)].sort((a, b) => b - a),
        'the rest by reranked score',
      );
    });
  }

  it('a failed rerank with keepStage1Top returns the RERANK_ERROR — never the stage-1 result (D71)', async () => {
    const rag = await fixture();
    const { reranker } = spy(() => new Error('bad'));
    const r = await staged(rag, { reranker, keepStage1Top: 1 }).retrieve(
      rag,
      q('needle'),
      3,
    );
    assert.ok(!r.ok && r.error.code === 'RERANK_ERROR');
  });

  it('keepStage1Top with ScoreFloorCut is rejected at construction (keepStage1Top is unmeasured, D7)', async () => {
    const rag = await fixture();
    const { reranker } = spy(reversed);
    assert.throws(
      () => staged(rag, { reranker, keepStage1Top: 1 }, floor()),
      /^Error: StagedRetrieval: keepStage1Top cannot be combined with ScoreFloorCut — keepStage1Top is unmeasured \(D7\)/,
    );
    // keepStage1Top with a rank-order cut stays allowed
    assert.doesNotThrow(() => staged(rag, { reranker, keepStage1Top: 1 }));
  });

  it('ScoreFloorCut with a reranker is allowed — a failed rerank is an error, never stage-1 scores (D71)', async () => {
    const rag = await fixture();
    const { reranker } = spy(reversed);
    assert.doesNotThrow(() => staged(rag, { reranker }, floor()));
    assert.doesNotThrow(
      () => staged(rag, undefined, floor()),
      'without a reranker the floor cuts stage-1 scores, calibrated on them',
    );
  });

  /** O is an orphan (its canonical deleted; its itemText 'oscar' still reaches the reranker). */
  async function orphanFixture(
    stage1: Record<string, number>,
    withPin = false,
  ) {
    const raw = new InMemoryRag();
    if (withPin) await put(raw, 'P', [['full', 'needle papa']]);
    await put(raw, 'O', [
      ['full', 'oscar'],
      ['summary', 'needle'],
    ]);
    await raw.writer().deleteByIdRaw(recordId(G, 'O', 'full', 0));
    await put(raw, 'S', [['full', 'needle sierra']]);
    await put(raw, 'R', [['full', 'needle romeo']]);
    return scored(matchesOnly(raw), stage1);
  }
  /** Scores by item text, sorted descending — as a reranker returns them. */
  const byText = (s: Record<string, number>) =>
    spy((c) =>
      c
        .map((r) => ({ ...r, score: s[r.text] ?? 0 }))
        .sort((a, b) => b.score - a.score),
    );
  const withPool = (s: StagedRetrieval, n: number) =>
    new StagedRetrieval({ ...s.options, pool: new ItemPool(n) });

  it('an orphan replacement that outscores a surviving item is merged above it before the cut (§4.6, D67)', async () => {
    // Pool of 2: O (orphan) + S; R is the overflow. Reranked: S 0.1, R 0.9 — the same query.
    const rag = await orphanFixture({ O: 0.95, S: 0.5, R: 0.3 });
    const { reranker, seen } = byText({
      oscar: 0.95,
      'needle sierra': 0.1,
      'needle romeo': 0.9,
    });
    const cut = new ScoreFloorCut({ minItems: 0, maxItems: 2, minScore: 0.5 });
    const r = await withPool(staged(rag, { reranker }, cut), 2).retrieve(
      rag,
      q('needle'),
      2,
    );
    assert.deepEqual(ids(r), ['R']);
    assert.ok(r.ok);
    assert.equal(r.value[0].score, 0.9);
    assert.deepEqual(
      seen.map((x) => [x.query, x.texts]),
      [
        ['needle', ['oscar', 'needle sierra']],
        ['needle', ['needle romeo']],
      ],
      'the pool, then one replacement round against the same query',
    );
  });

  it('keepStage1Top: the pin stays at the head; a replacement merges into the rest by reranked score (§4.6, §4.7, D67)', async () => {
    // Pool of 3: P (stage-1 top, pinned), O (orphan), S; R is the overflow.
    const rag = await orphanFixture({ P: 0.99, O: 0.95, S: 0.5, R: 0.3 }, true);
    const { reranker } = byText({
      'needle papa': 0.05,
      oscar: 0.95,
      'needle sierra': 0.1,
      'needle romeo': 0.9,
    });
    const r = await withPool(
      staged(rag, { reranker, keepStage1Top: 1 }),
      3,
    ).retrieve(rag, q('needle'), 3);
    assert.ok(r.ok);
    assert.deepEqual(
      r.value.map((x) => [x.metadata.id, x.score]),
      [
        ['P', 0.05],
        ['R', 0.9],
        ['S', 0.1],
      ],
    );
  });
});

describe('checkRerankOutput', () => {
  const c = (id: string): RagResult => ({
    text: id,
    metadata: { id },
    score: 0,
  });
  const cands = [c('a'), c('b')];
  it('valid: same candidates, each once, finite scores', () => {
    assert.equal(
      checkRerankOutput(cands, [
        { ...c('b'), score: 0.9 },
        { ...c('a'), score: 0.1 },
      ]),
      undefined,
    );
  });
  it('wrong count, duplicate, unknown, non-finite', () => {
    assert.match(String(checkRerankOutput(cands, [c('a')])), /1 results for 2/);
    assert.match(String(checkRerankOutput(cands, [c('a'), c('a')])), /twice/);
    assert.match(
      String(checkRerankOutput(cands, [c('a'), c('z')])),
      /not a candidate/,
    );
    assert.match(
      String(
        checkRerankOutput(cands, [c('a'), { ...c('b'), score: Number.NaN }]),
      ),
      /non-finite/,
    );
  });
});
