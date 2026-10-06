// packages/llm-agent-libs/src/collections/__tests__/staged-retrieval.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type CallOptions,
  type IItemCut,
  type IRag,
  RagError,
  type RetrievalSource,
  recordId,
} from '@mcp-abap-adt/llm-agent';
import { InMemoryRag } from '@mcp-abap-adt/llm-agent-rag';
import {
  FixedItemsCut,
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
  sources: (options?: CallOptions) => RetrievalSource[],
  o: Partial<StagedRetrievalOptions> = {},
) {
  return new StagedRetrieval({
    name: 'test',
    storeKey: 'tools',
    pool: new ItemPool(10),
    maxRecordsPerItem: 3,
    canonicalKind: 'full',
    sources: { sources: async (options) => sources(options) },
    collapse: new MaxScoreCollapse(),
    ...o,
  });
}
const primary =
  (rag: IRag) =>
  (options?: CallOptions): RetrievalSource[] => [
    { name: 'primary', rag, options },
  ];

describe('StagedRetrieval — stage 1, collapse, hydration', () => {
  it('k counts items, not records (max collapse)', async () => {
    const raw = new InMemoryRag();
    await put(raw, 'A', [
      ['full', 'alpha tool'],
      ['summary', 'alpha alpha'],
      ['parameters', 'alpha beta'],
    ]);
    await put(raw, 'B', [['full', 'alpha gamma']]);
    await put(raw, 'C', [['full', 'delta']]);
    const rag = matchesOnly(raw);
    const r = await staged(primary(rag)).retrieve(rag, q('alpha'), 2);
    assert.deepEqual(ids(r), ['A', 'B']);
    assert.ok(r.ok);
    assert.deepEqual(
      [...(r.value[0].metadata.matchedKinds as string[])].sort(),
      ['full', 'parameters', 'summary'],
    );
    assert.equal(r.value[0].metadata.source, 'primary');
  });

  it('the candidate pool is counted in items: every item with maxRecordsPerItem records still yields n items', async () => {
    const raw = new InMemoryRag();
    for (let i = 0; i < 5; i++) {
      await put(raw, `T${i}`, [
        ['full', `zeta i${i}`],
        ['summary', `zeta zeta s${i}`],
        ['parameters', `zeta p${i}`],
      ]);
    }
    const seenK: number[] = [];
    const rag = matchesOnly(raw, seenK);
    const r = await staged(primary(rag), { pool: new ItemPool(4) }).retrieve(
      rag,
      q('zeta'),
      4,
    );
    assert.deepEqual(seenK, [12]);
    assert.ok(r.ok);
    assert.equal(new Set(r.value.map((x) => x.metadata.id)).size, 4);
  });

  it('only a secondary record matches → the full payload (canonical text + data) is returned', async () => {
    const raw = new InMemoryRag();
    await put(
      raw,
      'X',
      [
        ['full', 'canonical words here'],
        ['summary', 'needle'],
      ],
      { data: { n: 1 } },
    );
    const rag = matchesOnly(raw);
    const r = await staged(primary(rag)).retrieve(rag, q('needle'), 1);
    assert.ok(r.ok);
    assert.equal(r.value[0].text, 'canonical words here');
    assert.deepEqual(r.value[0].metadata.data, { n: 1 });
    assert.equal(r.value[0].metadata.id, 'X');
    assert.deepEqual(r.value[0].metadata.matchedKinds, ['summary']);
  });

  it('a hit without its canonical record is an orphan: dropped, never its own text, does not use up k', async () => {
    const raw = new InMemoryRag();
    await put(raw, 'Y', [
      ['full', 'yankee'],
      ['summary', 'needle'],
    ]);
    await raw.writer().deleteByIdRaw(recordId(G, 'Y', 'full', 0));
    await put(raw, 'Z', [['full', 'needle zulu']]);
    const rag = matchesOnly(raw);
    const r = await staged(primary(rag)).retrieve(rag, q('needle'), 1);
    assert.deepEqual(ids(r), ['Z']);
  });

  it('default pool, k=1: a top orphan does not use up the pool — the next fetched item replaces it (§4.6, D67)', async () => {
    const raw = new InMemoryRag();
    await put(raw, 'Y', [
      ['full', 'yankee'],
      ['summary', 'needle'],
    ]);
    await raw.writer().deleteByIdRaw(recordId(G, 'Y', 'full', 0));
    await put(raw, 'Z', [['full', 'needle zulu xray whiskey']]);
    const rag = matchesOnly(raw);
    const top = await rag.query(q('needle'), 3);
    assert.ok(top.ok);
    assert.equal(
      top.value[0]?.metadata.itemId,
      'Y',
      'precondition: the orphan ranks first',
    );
    // pool omitted → ItemPool(): the pool is k = 1 item; Z is fetched (k × maxRecordsPerItem = 3 records) but outside it
    const r = await staged(primary(rag), { pool: undefined }).retrieve(
      rag,
      q('needle'),
      1,
    );
    assert.deepEqual(ids(r), ['Z']);
  });

  it('replacements merge with the pool by DESCENDING stage-1 score before the cut (§4.6, D67)', async () => {
    // Default pool at k=2 = 2 items per source. 'left' pools two top orphans and keeps R (0.9) in
    // its overflow; 'right' pools S (0.1). Appended, R would sit below S, and the floor — it stops
    // at the first score below minScore — would return nothing.
    const left = new InMemoryRag();
    for (const id of ['O1', 'O2']) {
      await put(left, id, [
        ['full', `gone ${id}`],
        ['summary', 'needle'],
      ]);
      await left.writer().deleteByIdRaw(recordId(G, id, 'full', 0));
    }
    await put(left, 'R', [['full', 'needle romeo']]);
    const right = new InMemoryRag();
    await put(right, 'S', [['full', 'needle sierra']]);
    const by = { O1: 0.95, O2: 0.93, R: 0.9, S: 0.1 };
    const l = scored(matchesOnly(left), by);
    const rt = scored(matchesOnly(right), by);
    const both = (options?: CallOptions): RetrievalSource[] => [
      { name: 'left', rag: l, options },
      { name: 'right', rag: rt, options },
    ];
    const floor = new ScoreFloorCut({
      minItems: 0,
      maxItems: 2,
      minScore: 0.5,
    });
    const r = await staged(both, { pool: undefined, cut: floor }).retrieve(
      l,
      q('needle'),
      2,
    );
    assert.deepEqual(ids(r), ['R']);
    const all = await staged(both, { pool: undefined }).retrieve(
      l,
      q('needle'),
      2,
    );
    assert.deepEqual(
      ids(all),
      ['R', 'S'],
      'one descending list, not the pool then the replacement',
    );
  });

  it('a stale secondary record of a live item hydrates to the CURRENT canonical record', async () => {
    const raw = new InMemoryRag();
    await put(raw, 'L', [['full', 'current text']]);
    await raw.writer().upsertRaw(recordId(G, 'L', 'summary', 0), 'needle', {
      itemId: 'L',
      recordKind: 'summary',
      visibility: 'global',
      itemText: 'stale text',
    });
    const rag = matchesOnly(raw);
    const r = await staged(primary(rag)).retrieve(rag, q('needle'), 1);
    assert.ok(r.ok);
    assert.equal(r.value[0].text, 'current text');
  });

  it('a canonical record outside the source identity filter is dropped', async () => {
    const raw = new InMemoryRag();
    const alice = { scope: 'user', userId: 'alice' } as const;
    await raw.writer().upsertRaw(recordId(alice, 'I', 'summary', 0), 'needle', {
      itemId: 'I',
      recordKind: 'summary',
      visibility: 'user',
      userId: 'alice',
      itemText: 'x',
    });
    await raw.writer().upsertRaw(recordId(alice, 'I', 'full', 0), 'secret', {
      itemId: 'I',
      recordKind: 'full',
      visibility: 'user',
      userId: 'bob',
    });
    const rag = matchesOnly(raw);
    const r = await staged(() => [
      { name: 'user', rag, options: { ragFilter: { userId: 'alice' } } },
    ]).retrieve(rag, q('needle'), 3);
    assert.deepEqual(ids(r), []);
  });

  it("no pool given → ItemPool(): the caller's k items, k × maxRecordsPerItem records (D56)", async () => {
    const raw = new InMemoryRag();
    for (let i = 0; i < 5; i++) {
      await put(raw, `T${i}`, [
        ['full', `zeta i${i}`],
        ['summary', `zeta zeta s${i}`],
        ['parameters', `zeta p${i}`],
      ]);
    }
    const seenK: number[] = [];
    const rag = matchesOnly(raw, seenK);
    const r = await staged(primary(rag), { pool: undefined }).retrieve(
      rag,
      q('zeta'),
      2,
    );
    assert.deepEqual(seenK, [6]);
    assert.ok(r.ok);
    assert.equal(r.value.length, 2);
  });

  it('records without itemId (skills) pass through as themselves', async () => {
    const raw = new InMemoryRag();
    await raw
      .writer()
      .upsertRaw('skill:deploy', 'Skill: deploy needle', { name: 'deploy' });
    const rag = matchesOnly(raw);
    const r = await staged(primary(rag)).retrieve(rag, q('needle'), 3);
    assert.ok(r.ok);
    assert.equal(r.value[0].metadata.id, 'skill:deploy');
    assert.equal(r.value[0].text, 'Skill: deploy needle');
  });

  it('collapse keys on the owner-qualified item: two owners, one itemId, two items', async () => {
    const raw = new InMemoryRag();
    await put(raw, 'case-42', [['item', 'needle a']], {
      owner: { scope: 'user', userId: 'A' },
    });
    await put(raw, 'case-42', [['item', 'needle b']], {
      owner: { scope: 'user', userId: 'B' },
    });
    const rag = matchesOnly(raw);
    const r = await staged(primary(rag), { canonicalKind: 'item' }).retrieve(
      rag,
      q('needle'),
      5,
    );
    assert.ok(r.ok);
    assert.deepEqual(r.value.map((x) => x.metadata.userId).sort(), ['A', 'B']);
  });

  it('the cut is applied once: at most min(k, cut.limit(k)) items — the caller k caps every cut (F1)', async () => {
    const raw = new InMemoryRag();
    for (const id of ['a', 'b', 'c', 'd'])
      await put(raw, id, [['full', `needle ${id}x`]]);
    const rag = matchesOnly(raw);
    const fixed = await staged(primary(rag), {
      cut: new FixedItemsCut(2),
    }).retrieve(rag, q('needle'), 10);
    assert.ok(fixed.ok && fixed.value.length === 2);
    const capped = await staged(primary(rag), {
      cut: new FixedItemsCut(3),
    }).retrieve(rag, q('needle'), 1);
    assert.ok(capped.ok && capped.value.length === 1);
    const top = await staged(primary(rag)).retrieve(rag, q('needle'), 3);
    assert.ok(top.ok && top.value.length === 3);
    // a consumer cut whose limit ignores k is still capped by StagedRetrieval
    const greedy: IItemCut = {
      name: 'greedy',
      limit: () => 10,
      cut: (items) => [...items],
    };
    const g = await staged(primary(rag), { cut: greedy }).retrieve(
      rag,
      q('needle'),
      2,
    );
    assert.ok(g.ok && g.value.length === 2);
  });

  it('every source holds items: a hit belongs to the source it came from; one itemId in two sources is two items (D50)', async () => {
    const left = new InMemoryRag();
    const right = new InMemoryRag();
    await put(left, 'T', [
      ['full', 'tango left'],
      ['summary', 'needle'],
    ]);
    await put(right, 'T', [
      ['full', 'tango right'],
      ['summary', 'needle'],
    ]);
    const both = (options?: CallOptions): RetrievalSource[] => [
      { name: 'left', rag: matchesOnly(left), options },
      { name: 'right', rag: matchesOnly(right), options },
    ];
    const r = await staged(both).retrieve(left, q('needle'), 3);
    assert.ok(r.ok);
    assert.deepEqual(r.value.map((x) => [x.metadata.source, x.text]).sort(), [
      ['left', 'tango left'],
      ['right', 'tango right'],
    ]);
    assert.deepEqual(r.value[0].metadata.matchedKinds, ['summary']);
  });

  it('a store error is returned', async () => {
    const failing: IRag = {
      query: async () => ({ ok: false, error: new RagError('down') }),
      healthCheck: async () => ({ ok: true, value: undefined }),
      getById: async () => ({ ok: true, value: null }),
    };
    const r = await staged(primary(failing)).retrieve(failing, q('x'), 3);
    assert.equal(r.ok, false);
  });
});

describe('StagedRetrieval — pass-through records and fail loud', () => {
  it('a record without itemId is its own unit beside items: keyed by metadata.id, returned as itself, never hydrated (§4.3)', async () => {
    const raw = new InMemoryRag();
    await raw
      .writer()
      .upsertRaw('skill:deploy', 'Skill: deploy needle', { name: 'deploy' });
    await put(raw, 'A', [
      ['full', 'alpha tool'],
      ['summary', 'needle'],
    ]);
    const reads: string[] = [];
    const base = scored(matchesOnly(raw), { A: 0.9 });
    const rag: IRag = {
      ...base,
      query: async (qq, k, o) => {
        const r = await base.query(qq, k, o);
        if (!r.ok) return r;
        // the skill record ranks between nothing and A: its own stage-1 score
        const value = r.value
          .map((x) =>
            x.metadata.id === 'skill:deploy' ? { ...x, score: 0.5 } : x,
          )
          .sort((a, b) => b.score - a.score);
        return { ok: true, value };
      },
      getById: (id, o) => {
        reads.push(id);
        return raw.getById(id, o);
      },
    };
    const r = await staged(primary(rag)).retrieve(rag, q('needle'), 5);
    assert.ok(r.ok);
    assert.deepEqual(
      r.value.map((x) => x.metadata.id),
      ['A', 'skill:deploy'],
    );
    const skill = r.value[1];
    assert.equal(skill.text, 'Skill: deploy needle');
    assert.equal(skill.score, 0.5);
    assert.equal(skill.metadata.name, 'deploy');
    assert.equal(
      skill.metadata.matchedKinds,
      undefined,
      'returned as the record itself',
    );
    assert.equal(
      skill.metadata.source,
      undefined,
      'returned as the record itself',
    );
    assert.deepEqual(
      reads,
      [recordId(G, 'A', 'full', 0)],
      'only the item is hydrated',
    );
  });

  it('a pass-through record counts against k like an item', async () => {
    const raw = new InMemoryRag();
    await raw
      .writer()
      .upsertRaw('skill:deploy', 'needle needle needle', { name: 'deploy' });
    await put(raw, 'A', [['full', 'needle alpha']]);
    const rag = scored(matchesOnly(raw), { A: 0.1 });
    const r = await staged(primary(rag)).retrieve(rag, q('needle'), 1);
    assert.deepEqual(ids(r), ['skill:deploy']);
  });

  it("a source's Result error is returned with its code", async () => {
    const failing: IRag = {
      query: async () => ({
        ok: false,
        error: new RagError('down', 'CIRCUIT_OPEN'),
      }),
      healthCheck: async () => ({ ok: true, value: undefined }),
      getById: async () => ({ ok: true, value: null }),
    };
    const r = await staged(primary(failing)).retrieve(failing, q('x'), 3);
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'CIRCUIT_OPEN');
  });

  it('a query that rejects is a Result error, never a rejection of retrieve', async () => {
    const throwing: IRag = {
      query: async () => {
        throw new RagError('socket hang up', 'CIRCUIT_OPEN');
      },
      healthCheck: async () => ({ ok: true, value: undefined }),
      getById: async () => ({ ok: true, value: null }),
    };
    const r = await staged(primary(throwing)).retrieve(throwing, q('x'), 3);
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'CIRCUIT_OPEN');
    assert.match(r.error.message, /socket hang up/);
    const plain: IRag = {
      ...throwing,
      query: async () => Promise.reject(new Error('boom')),
    };
    const p = await staged(primary(plain)).retrieve(plain, q('x'), 3);
    assert.ok(!p.ok);
    assert.equal(p.error.code, 'RAG_ERROR');
    assert.match(p.error.message, /boom/);
  });

  it('a hydration read error is returned with its code — on both paths (Result error, rejection)', async () => {
    const raw = new InMemoryRag();
    await put(raw, 'X', [
      ['full', 'canonical words'],
      ['summary', 'needle'],
    ]);
    const base = matchesOnly(raw);
    const errored: IRag = {
      ...base,
      getById: async () => ({
        ok: false,
        error: new RagError('read down', 'RAG_READ_FAILED'),
      }),
    };
    const e = await staged(primary(errored)).retrieve(errored, q('needle'), 1);
    assert.ok(!e.ok);
    assert.equal(e.error.code, 'RAG_READ_FAILED');
    const rejecting: IRag = {
      ...base,
      getById: async () => {
        throw new RagError('read hang up', 'CIRCUIT_OPEN');
      },
    };
    const j = await staged(primary(rejecting)).retrieve(
      rejecting,
      q('needle'),
      1,
    );
    assert.ok(!j.ok);
    assert.equal(j.error.code, 'CIRCUIT_OPEN');
  });

  it('a collapsed item naming no queried source is an error, never skipped', async () => {
    const raw = new InMemoryRag();
    await put(raw, 'A', [['full', 'needle alpha']]);
    const rag = matchesOnly(raw);
    const stray: StagedRetrievalOptions['collapse'] = {
      name: 'stray',
      collapse: (hits) =>
        new MaxScoreCollapse()
          .collapse(hits)
          .map((c) => ({ ...c, source: 'elsewhere' })),
    };
    const r = await staged(primary(rag), { collapse: stray }).retrieve(
      rag,
      q('needle'),
      1,
    );
    assert.ok(!r.ok);
    assert.match(r.error.message, /elsewhere/);
  });

  it('two sources with one name are an error: their items could not be told apart', async () => {
    const raw = new InMemoryRag();
    await put(raw, 'A', [['full', 'needle alpha']]);
    const rag = matchesOnly(raw);
    const twice = (options?: CallOptions): RetrievalSource[] => [
      { name: 'primary', rag, options },
      { name: 'primary', rag, options },
    ];
    const r = await staged(twice).retrieve(rag, q('needle'), 1);
    assert.ok(!r.ok);
    assert.match(r.error.message, /primary/);
  });
});
