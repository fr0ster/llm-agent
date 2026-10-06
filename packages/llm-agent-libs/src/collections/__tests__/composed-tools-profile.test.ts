// packages/llm-agent-libs/src/collections/__tests__/composed-tools-profile.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type CallOptions,
  type IBoundCollection,
  type ICollectionProfile,
  type IRag,
  type IReranker,
  RagError,
  recordId,
  TextOnlyEmbedding,
  type ToolItem,
  toolNameFromRecord,
} from '@mcp-abap-adt/llm-agent';
import { InMemoryRag } from '@mcp-abap-adt/llm-agent-rag';
import { heldRerankers } from '../../health/agent-health.js';
import { hasRetrievalStrategy } from '../../retrieval/index.js';
import {
  bindToolsProfile,
  ComposedToolsProfile,
  EnumValueToolIndexer,
  FacetedToolIndexer,
  ItemPool,
  MaxScoreCollapse,
  RequiredEnumDiscriminator,
  SummaryFacet,
  toolItemFromTool,
  toolsBindingOf,
} from '../index.js';

const G = { scope: 'global' } as const;
const tool = (name: string, description: string) =>
  toolItemFromTool(
    { name, description },
    { itemId: `tool:${name}`, originalName: name },
  );
const TOOLS = [
  tool('read_file', 'Read a file from disk'),
  tool('list_issues', 'List open issues'),
];
const profile = (
  extra: Partial<ConstructorParameters<typeof ComposedToolsProfile>[0]> = {},
) =>
  new ComposedToolsProfile({
    indexer: new FacetedToolIndexer([new SummaryFacet()]),
    pool: new ItemPool(10),
    collapse: new MaxScoreCollapse(),
    ...extra,
  });

describe('ComposedToolsProfile', () => {
  it('index → report counted in items; get returns the canonical item', async () => {
    const rag = new InMemoryRag();
    const bound = profile().bind({ key: 'tools', rag });
    const r = await bound.index(TOOLS);
    assert.ok(r.ok);
    assert.deepEqual(r.value, {
      items: 2,
      indexedItems: 2,
      records: 4,
      failedItems: [],
    });
    const g = await bound.get({ itemId: 'tool:read_file', owner: G });
    assert.ok(g.ok);
    assert.equal(g.value?.text, 'Tool: read_file — Read a file from disk');
    assert.equal(g.value?.metadata.profile, 'mcp-tools');
  });

  it('retrieval through bound.rag: items keep metadata.id = itemId, so name-based consumers work unchanged', async () => {
    const rag = new InMemoryRag();
    const bound = profile().bind({ key: 'tools', rag });
    await bound.index(TOOLS);
    assert.equal(hasRetrievalStrategy(bound.rag), true);
    const r = await bound.rag.query(new TextOnlyEmbedding('read file'), 1);
    assert.ok(r.ok);
    assert.equal(r.value[0].metadata.id, 'tool:read_file');
    assert.equal(toolNameFromRecord(r.value[0].metadata), 'read_file');
  });

  it("no pool given → the generic default, the caller's k items (D56)", async () => {
    const rag = new InMemoryRag();
    const bound = new ComposedToolsProfile({
      indexer: new FacetedToolIndexer([new SummaryFacet()]),
      collapse: new MaxScoreCollapse(),
    }).bind({ key: 'tools', rag });
    await bound.index(TOOLS);
    const r = await bound.rag.query(new TextOnlyEmbedding('read file'), 2);
    assert.ok(r.ok);
    assert.equal(r.value.length, 2);
    assert.equal(r.value[0].metadata.id, 'tool:read_file');
  });

  it('too many records → failedItems too-many-records', async () => {
    const rag = new InMemoryRag();
    const coarse = toolItemFromTool(
      {
        name: 'make',
        description: 'Make',
        inputSchema: {
          properties: { kind: { enum: ['A', 'B', 'C'] } },
          required: ['kind'],
        },
      },
      { itemId: 'tool:make', originalName: 'make' },
    );
    const bound = profile({
      indexer: new EnumValueToolIndexer(new FacetedToolIndexer([]), {
        discriminator: new RequiredEnumDiscriminator(),
        maxValues: 2,
      }),
    }).bind({ key: 'tools', rag });
    const r = await bound.index([coarse]);
    assert.ok(r.ok);
    assert.deepEqual(r.value.failedItems, [
      { itemId: 'tool:make', reason: 'too-many-records' },
    ]);
    assert.equal(r.value.indexedItems, 0);
  });

  it('remove deletes the item records', async () => {
    const rag = new InMemoryRag();
    const bound = profile().bind({ key: 'tools', rag });
    await bound.index(TOOLS);
    const n = await bound.remove([{ itemId: 'tool:read_file', owner: G }]);
    assert.ok(n.ok && n.value === 2);
  });

  it('two versions of one tool in one batch → an error naming it; nothing written (spec §3.3)', async () => {
    const rag = new InMemoryRag();
    const bound = profile().bind({ key: 'tools', rag });
    const r = await bound.index([
      ...TOOLS,
      tool('read_file', 'Read a file (v2)'),
    ]);
    assert.ok(!r.ok);
    assert.match(
      r.error.message,
      /duplicate item ids in one batch.*global\/tool:read_file \(2×\)/,
    );
    for (const id of ['tool:read_file', 'tool:list_issues']) {
      const x = await rag.getById(recordId(G, id, 'full', 0));
      assert.ok(x.ok && x.value === null, id);
    }
  });
});

describe('bindToolsProfile / toolsBindingOf', () => {
  it('binds once per store (server + builder), found through decorators', () => {
    const raw: IRag = new InMemoryRag();
    const p = profile();
    const a = bindToolsProfile(p, { key: 'tools', rag: raw });
    const b = bindToolsProfile(p, { key: 'tools', rag: a.rag });
    assert.equal(a, b);
    const decorated: IRag = {
      inner: a.rag,
      query: (e, k, o) => a.rag.query(e, k, o),
      healthCheck: (o) => a.rag.healthCheck(o),
      getById: (i, o) => a.rag.getById(i, o),
    } as IRag;
    assert.equal(toolsBindingOf(decorated), a);
    assert.equal(toolsBindingOf(raw), undefined);
  });
});

describe('stale records (F3) and notes (S1) in the binding', () => {
  it('re-indexing without a facet deletes the old facet record', async () => {
    const rag = new InMemoryRag();
    await profile().bind({ key: 'tools', rag }).index(TOOLS);
    await profile({ indexer: new FacetedToolIndexer([]) })
      .bind({ key: 'tools', rag })
      .index(TOOLS);
    const gone = await rag.getById(recordId(G, 'tool:read_file', 'summary', 0));
    assert.ok(gone.ok && gone.value === null);
    const canon = await rag.getById(recordId(G, 'tool:read_file', 'full', 0));
    assert.ok(canon.ok && canon.value?.metadata.staleRecordIds === undefined);
  });

  it('F3: a failed stale delete is reported cleanup-failed and retried by the next index', async () => {
    // InMemoryRag.writer() returns a FRESH object per call (in-memory-rag.ts `writer()`), so
    // patching one writer instance changes nothing: wrap the store instead.
    const raw = new InMemoryRag();
    const sid = recordId(G, 'tool:read_file', 'summary', 0);
    let fail = true;
    const rag = {
      query: raw.query.bind(raw),
      healthCheck: raw.healthCheck.bind(raw),
      getById: raw.getById.bind(raw),
      writer: () => {
        const w = raw.writer();
        return {
          ...w,
          deleteByIdRaw: async (id: string, o?: CallOptions) =>
            fail && id === sid
              ? { ok: false as const, error: new RagError('down') }
              : w.deleteByIdRaw(id, o),
        };
      },
    } as IRag;
    await profile().bind({ key: 'tools', rag }).index(TOOLS);
    const again = profile({ indexer: new FacetedToolIndexer([]) }).bind({
      key: 'tools',
      rag,
    });
    const r1 = await again.index(TOOLS);
    assert.ok(r1.ok);
    assert.deepEqual(
      r1.value.failedItems.map((f) => f.itemId),
      ['tool:read_file'],
    );
    assert.match(r1.value.failedItems[0].reason, /^cleanup-failed/);
    const listed = await raw.getById(recordId(G, 'tool:read_file', 'full', 0));
    assert.ok(listed.ok);
    assert.deepEqual(listed.value?.metadata.staleRecordIds, [sid]);
    fail = false;
    const r2 = await again.index(TOOLS);
    assert.ok(r2.ok && r2.value.failedItems.length === 0);
    const gone = await raw.getById(sid);
    assert.ok(gone.ok && gone.value === null);
    const n = await again.remove([{ itemId: 'tool:read_file', owner: G }]);
    assert.ok(n.ok);
    const canon = await raw.getById(recordId(G, 'tool:read_file', 'full', 0));
    assert.ok(canon.ok && canon.value === null);
  });

  it('notes from the indexer land in IndexReport.notes with the item id', async () => {
    const coarse = toolItemFromTool(
      {
        name: 'make',
        description: 'Make',
        inputSchema: {
          properties: {
            kind: { enum: ['A', 'B'] },
            region: { enum: ['EU', 'US'] },
          },
          required: ['kind', 'region'],
        },
      },
      { itemId: 'tool:make', originalName: 'make' },
    );
    const bound = profile({
      indexer: new EnumValueToolIndexer(new FacetedToolIndexer([]), {
        discriminator: new RequiredEnumDiscriminator(),
        maxValues: 5,
      }),
    }).bind({ key: 'tools', rag: new InMemoryRag() });
    const r = await bound.index([coarse]);
    assert.ok(r.ok);
    assert.deepEqual(r.value.notes, [
      {
        itemId: 'tool:make',
        note: 'ambiguous-discriminator',
        detail: 'kind, region',
      },
    ]);
    assert.equal(r.value.indexedItems, 1);
  });
});

/** An InMemoryRag whose embedder batches (and may fail) and whose writer takes vectors. */
function batchingStore(embedDocuments: () => Promise<{ vector: number[] }[]>) {
  const raw = new InMemoryRag();
  const vec = async () => ({ vector: [1, 0] });
  return {
    raw,
    rag: {
      query: raw.query.bind(raw),
      healthCheck: raw.healthCheck.bind(raw),
      getById: raw.getById.bind(raw),
      retrievalEmbedder: {
        embedDocument: vec,
        embedQuery: vec,
        embedDocuments,
      },
      writer: () => {
        const w = raw.writer();
        return {
          ...w,
          upsertPrecomputedRaw: (
            id: string,
            text: string,
            _v: number[],
            meta: Record<string, unknown>,
            o?: CallOptions,
          ) => w.upsertRaw(id, text, meta, o),
        };
      },
    } as unknown as IRag,
  };
}

describe('fail loud in the binding (Task 11 carry-over, Task 4R)', () => {
  it('a failed batch embedding is visible: a batch-embedding-failed note per item written through the per-record path', async () => {
    const { rag } = batchingStore(async () => {
      throw new Error('embed down');
    });
    const r = await profile().bind({ key: 'tools', rag }).index(TOOLS);
    assert.ok(r.ok);
    assert.equal(r.value.indexedItems, 2);
    assert.deepEqual(r.value.notes, [
      {
        itemId: 'tool:read_file',
        note: 'batch-embedding-failed',
        detail: 'embed down',
      },
      {
        itemId: 'tool:list_issues',
        note: 'batch-embedding-failed',
        detail: 'embed down',
      },
    ]);
  });

  it('a working batch embedding adds no note', async () => {
    const { rag } = batchingStore(async () =>
      Array.from({ length: 4 }, () => ({ vector: [1, 0] })),
    );
    const r = await profile().bind({ key: 'tools', rag }).index(TOOLS);
    assert.ok(r.ok);
    assert.equal(r.value.indexedItems, 2);
    assert.equal('notes' in r.value, false);
  });

  it('an indexer whose toRecords rejects → that item fails with the error; the others are indexed', async () => {
    const inner = new FacetedToolIndexer([new SummaryFacet()]);
    const indexer = {
      name: 'rejecting',
      maxRecordsPerItem: inner.maxRecordsPerItem,
      canonicalKind: inner.canonicalKind,
      toRecords: (t: ToolItem) =>
        t.itemId === 'tool:read_file'
          ? Promise.reject(new Error('indexer blew up'))
          : inner.toRecords(t),
    };
    const r = await profile({ indexer })
      .bind({ key: 'tools', rag: new InMemoryRag() })
      .index(TOOLS);
    assert.ok(r.ok);
    assert.deepEqual(r.value.failedItems, [
      { itemId: 'tool:read_file', reason: 'indexer blew up' },
    ]);
    assert.equal(r.value.indexedItems, 1);
  });

  it('a store whose writer() throws → index returns the error with its code (never a rejection)', async () => {
    const raw = new InMemoryRag();
    const rag = {
      query: raw.query.bind(raw),
      healthCheck: raw.healthCheck.bind(raw),
      getById: raw.getById.bind(raw),
      writer: () => {
        throw new RagError('writer gone', 'RAG_READ_ONLY');
      },
    } as IRag;
    const r = await profile().bind({ key: 'tools', rag }).index(TOOLS);
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'RAG_READ_ONLY');
    assert.match(r.error.message, /writer gone/);
  });

  it('a store whose writer() throws on remove → remove returns the error with its code', async () => {
    const raw = new InMemoryRag();
    let broken = false;
    const rag = {
      query: raw.query.bind(raw),
      healthCheck: raw.healthCheck.bind(raw),
      getById: raw.getById.bind(raw),
      writer: () => {
        if (broken) throw new RagError('writer gone', 'RAG_READ_ONLY');
        return raw.writer();
      },
    } as IRag;
    const bound = profile().bind({ key: 'tools', rag });
    assert.ok((await bound.index(TOOLS)).ok);
    broken = true;
    const r = await bound.remove([{ itemId: 'tool:read_file', owner: G }]);
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'RAG_READ_ONLY');
  });

  it("the health probe finds the tools binding's reranker through the store's strategy (D97)", () => {
    const reranker: IReranker = {
      rerank: async (_q, c) => ({ ok: true, value: c }),
    };
    const bound = profile({ rerank: { reranker } }).bind({
      key: 'tools',
      rag: new InMemoryRag(),
    });
    const held = heldRerankers(undefined, { tools: bound.rag });
    assert.equal(held.length, 1);
    assert.equal(held[0].reranker, reranker);
    assert.equal(held[0].name, 'store:tools');
  });

  it("bindToolsProfile wraps a consumer profile's bare rag in the retrieval: its reranker is found too", () => {
    const reranker: IReranker = {
      rerank: async (_q, c) => ({ ok: true, value: c }),
    };
    const composed = profile({ rerank: { reranker } });
    // A consumer profile whose `rag` is the bare store (no StrategyRag).
    const consumer: ICollectionProfile<ToolItem> = {
      name: 'consumer-tools',
      bind: (target) => {
        const b = composed.bind(target);
        const bare: IBoundCollection<ToolItem> = {
          key: b.key,
          profileName: 'consumer-tools',
          rag: target.rag,
          retrieval: b.retrieval,
          index: (i, o) => b.index(i, o),
          remove: (r, o) => b.remove(r, o),
          get: (r, o) => b.get(r, o),
        };
        return bare;
      },
    };
    const bound = bindToolsProfile(consumer, {
      key: 'tools',
      rag: new InMemoryRag(),
    });
    assert.equal(hasRetrievalStrategy(bound.rag), true);
    assert.equal(toolsBindingOf(bound.rag), bound);
    const held = heldRerankers(undefined, { tools: bound.rag });
    assert.equal(held.length, 1);
    assert.equal(held[0].reranker, reranker);
  });
});
