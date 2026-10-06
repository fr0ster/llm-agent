// packages/llm-agent-libs/src/collections/__tests__/shared-items-profile.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type CallOptions,
  type IBoundCollection,
  type IRag,
  type IReranker,
  type ISharedItemGroups,
  isRagDecorator,
  RagError,
  recordId,
  type SharedItem,
  TextOnlyEmbedding,
} from '@mcp-abap-adt/llm-agent';
import { InMemoryRag } from '@mcp-abap-adt/llm-agent-rag';
import { heldRerankers } from '../../health/agent-health.js';
import { ItemPool, MaxScoreCollapse, SharedItemsProfile } from '../index.js';
import { matchesOnly } from './staged-retrieval-helpers.js';

const profile = () =>
  new SharedItemsProfile({
    maxRecordsPerItem: 3,
    pool: new ItemPool(10),
    collapse: new MaxScoreCollapse(),
  });
const A: CallOptions = { userId: 'A' };
const B: CallOptions = { userId: 'B' };
const userItem = (
  userId: string,
  text: string,
  extra: Partial<SharedItem> = {},
): SharedItem => ({
  itemId: 'case-42',
  visibility: { scope: 'user', userId },
  text,
  data: { by: userId },
  ...extra,
});
const retrieve = (
  bound: IBoundCollection<SharedItem>,
  text: string,
  o?: CallOptions,
) => bound.retrieval.retrieve(bound.rag, new TextOnlyEmbedding(text), 5, o);

describe('SharedItemsProfile', () => {
  it('identical item ids across users stay separate (get, re-index, remove, retrieval)', async () => {
    const user = new InMemoryRag();
    const bound = profile().bind({ key: 'shared', user: matchesOnly(user) });
    await bound.index([userItem('A', 'alpha needle')], A);
    await bound.index([userItem('B', 'bravo needle')], B);
    // Both items match 'needle': only the user filter (ragFilter.userId, spec §8.3) keeps each user to their own.
    const asA = await retrieve(bound, 'needle', A);
    assert.ok(asA.ok);
    assert.deepEqual(
      asA.value.map((x) => x.metadata.userId),
      ['A'],
    );
    const asB = await retrieve(bound, 'needle', B);
    assert.ok(asB.ok);
    assert.deepEqual(
      asB.value.map((x) => x.metadata.userId),
      ['B'],
    );
    const idA = recordId({ scope: 'user', userId: 'A' }, 'case-42', 'item', 0);
    const idB = recordId({ scope: 'user', userId: 'B' }, 'case-42', 'item', 0);
    assert.notEqual(idA, idB);
    const getA = await bound.get(
      { itemId: 'case-42', owner: { scope: 'user', userId: 'A' } },
      A,
    );
    assert.ok(getA.ok);
    assert.equal(getA.value?.text, 'alpha needle');
    assert.deepEqual(getA.value?.metadata.data, { by: 'A' });
    await bound.index([userItem('B', 'bravo changed')], B);
    const stillA = await user.getById(idA);
    assert.ok(stillA.ok && stillA.value?.text === 'alpha needle');
    const rm = await bound.remove(
      [{ itemId: 'case-42', owner: { scope: 'user', userId: 'B' } }],
      B,
    );
    assert.ok(rm.ok && rm.value === 1, 'B removed exactly its own canonical');
    const goneB = await user.getById(idB);
    assert.ok(goneB.ok && goneB.value === null);
    const afterRemove = await user.getById(idA);
    assert.ok(afterRemove.ok && afterRemove.value !== null);
    const r = await retrieve(bound, 'needle', A);
    assert.ok(r.ok);
    assert.deepEqual(
      r.value.map((x) => x.metadata.userId),
      ['A'],
    );
  });

  it('flattens owner keys per visibility', async () => {
    const user = new InMemoryRag();
    const global = new InMemoryRag();
    const group = new InMemoryRag();
    const groups: ISharedItemGroups = {
      readable: async () => [{ groupId: 'g1', rag: group }],
      writable: async (id) => (id === 'g1' ? group : undefined),
    };
    const bound = profile().bind({ key: 'shared', user, global, groups });
    const r = await bound.index(
      [
        userItem('A', 'u'),
        {
          itemId: 'g',
          visibility: { scope: 'group', groupId: 'g1' },
          text: 'g',
        },
        {
          itemId: 'x',
          visibility: { scope: 'global' },
          text: 'x',
          ttl: 4102444800,
        },
      ],
      A,
    );
    assert.ok(r.ok && r.value.indexedItems === 3);
    const g = await group.getById(
      recordId({ scope: 'group', groupId: 'g1' }, 'g', 'item', 0),
    );
    assert.ok(
      g.ok &&
        g.value?.metadata.groupId === 'g1' &&
        g.value.metadata.visibility === 'group',
    );
    const x = await global.getById(
      recordId({ scope: 'global' }, 'x', 'item', 0),
    );
    assert.ok(
      x.ok &&
        x.value?.metadata.visibility === 'global' &&
        x.value.metadata.ttl === 4102444800,
    );
  });

  it('refusals land in failedItems and write nothing', async () => {
    const user = new InMemoryRag();
    const bound = profile().bind({ key: 'shared', user });
    const r = await bound.index(
      [
        userItem('B', 'foreign'),
        userItem('A', 'k', {
          itemId: 'k1',
          records: [{ kind: 'item', text: 'x' }],
        }),
        userItem('A', 'm', {
          itemId: 'm1',
          records: [
            { kind: 'a', text: '1' },
            { kind: 'a', text: '2' },
            { kind: 'a', text: '3' },
          ],
        }),
        {
          itemId: 'gl',
          visibility: { scope: 'global' },
          text: 'no global store',
        },
      ],
      A,
    );
    assert.ok(r.ok);
    assert.deepEqual(
      r.value.failedItems.map((f) => f.reason),
      ['foreign-user', 'reserved-kind', 'too-many-records', 'no-partition'],
    );
    assert.equal(r.value.indexedItems, 0);
  });

  it('extra records are searchable and return the item whole', async () => {
    const user = new InMemoryRag();
    const bound = profile().bind({ key: 'shared', user: matchesOnly(user) });
    await bound.index(
      [
        userItem('A', 'the whole case', {
          records: [{ kind: 'symptom', text: 'needle' }],
        }),
      ],
      A,
    );
    const r = await retrieve(bound, 'needle', A);
    assert.ok(r.ok);
    assert.equal(r.value[0].text, 'the whole case');
    assert.deepEqual(r.value[0].metadata.matchedKinds, ['symptom']);
  });

  it('the user partition is skipped without a userId (fail closed); global still answers', async () => {
    const user = new InMemoryRag();
    const global = new InMemoryRag();
    const bound = profile().bind({
      key: 'shared',
      user: matchesOnly(user),
      global: matchesOnly(global),
    });
    await bound.index(
      [
        userItem('A', 'needle mine'),
        {
          itemId: 'pub',
          visibility: { scope: 'global' },
          text: 'needle public',
        },
      ],
      A,
    );
    const r = await retrieve(bound, 'needle');
    assert.ok(r.ok);
    assert.deepEqual(
      r.value.map((x) => x.metadata.id),
      ['pub'],
    );
  });

  it('bound.rag answers no bare-id read or direct partition query — an error, never an empty success (D69)', async () => {
    const user = new InMemoryRag();
    const bound = profile().bind({ key: 'shared', user: matchesOnly(user) });
    await bound.index([userItem('A', 'alpha needle')], A);
    const byId = await bound.rag.getById(
      recordId({ scope: 'user', userId: 'A' }, 'case-42', 'item', 0),
      A,
    );
    assert.ok(!byId.ok && byId.error.code === 'RAG_ERROR');
    assert.match(byId.error.message, /bound\.get/);
    assert.ok(isRagDecorator(bound.rag));
    const direct = await bound.rag.inner.query(
      new TextOnlyEmbedding('needle'),
      5,
      A,
    );
    assert.ok(!direct.ok && direct.error.code === 'RAG_ERROR');
    const viaRetrieval = await bound.rag.query(
      new TextOnlyEmbedding('needle'),
      5,
      A,
    );
    assert.ok(
      viaRetrieval.ok && viaRetrieval.value.length === 1,
      'bound.rag.query reads through the retrieval',
    );
  });

  it("get is identity-checked; removing another user's item is refused", async () => {
    const user = new InMemoryRag();
    const bound = profile().bind({ key: 'shared', user });
    await bound.index([userItem('A', 'secret')], A);
    const asB = await bound.get(
      { itemId: 'case-42', owner: { scope: 'user', userId: 'A' } },
      B,
    );
    assert.ok(asB.ok && asB.value === null);
    const rm = await bound.remove(
      [{ itemId: 'case-42', owner: { scope: 'user', userId: 'A' } }],
      B,
    );
    assert.ok(!rm.ok && rm.error.code === 'OWNER_MISMATCH');
  });

  it('two versions of one item in one batch → an error naming it; no partition written (spec §3.3)', async () => {
    const user = new InMemoryRag();
    const global = new InMemoryRag();
    const bound = profile().bind({ key: 'shared', user, global });
    // The global item comes first: a per-store check would already have written it.
    const r = await bound.index(
      [
        { itemId: 'pub', visibility: { scope: 'global' }, text: 'public' },
        userItem('A', 'v1'),
        userItem('A', 'v2'),
      ],
      A,
    );
    assert.ok(!r.ok);
    assert.match(
      r.error.message,
      /duplicate item ids in one batch.*user:A\/case-42 \(2×\)/,
    );
    const pub = await global.getById(
      recordId({ scope: 'global' }, 'pub', 'item', 0),
    );
    assert.ok(
      pub.ok && pub.value === null,
      'the other partition is not written either',
    );
    const mine = await user.getById(
      recordId({ scope: 'user', userId: 'A' }, 'case-42', 'item', 0),
    );
    assert.ok(mine.ok && mine.value === null);
  });
});

/** An InMemoryRag whose embedder batches (and may fail) and whose writer takes vectors. */
function batchingStore(
  embedDocuments: () => Promise<{ vector: number[] }[]>,
): IRag {
  const raw = new InMemoryRag();
  const vec = async () => ({ vector: [1, 0] });
  return {
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
  } as unknown as IRag;
}

/** A store whose `writer()` throws a coded RagError (both failure paths of a Result call). */
function throwingWriter(): IRag {
  const raw = new InMemoryRag();
  return {
    query: raw.query.bind(raw),
    healthCheck: raw.healthCheck.bind(raw),
    getById: raw.getById.bind(raw),
    writer: () => {
      throw new RagError('writer down', 'UPSERT_ERROR');
    },
  };
}

describe('SharedItemsProfile — fail loud (carry-overs of Tasks 4R, 11, 15)', () => {
  it('a duplicate item id is refused over the WHOLE batch, also when one version is refused', async () => {
    const user = new InMemoryRag();
    const bound = profile().bind({ key: 'shared', user });
    const r = await bound.index(
      [
        // Refused (reserved kind) — its sibling must not be written as if alone.
        userItem('A', 'v1', { records: [{ kind: 'item', text: 'x' }] }),
        userItem('A', 'v2'),
      ],
      A,
    );
    assert.ok(!r.ok);
    assert.match(r.error.message, /user:A\/case-42 \(2×\)/);
    const mine = await user.getById(
      recordId({ scope: 'user', userId: 'A' }, 'case-42', 'item', 0),
    );
    assert.ok(mine.ok && mine.value === null);
  });

  it('a failed batch embedding is visible: a batch-embedding-failed note per item of that partition', async () => {
    const user = batchingStore(async () => {
      throw new Error('embed down');
    });
    const bound = profile().bind({ key: 'shared', user });
    const r = await bound.index(
      [userItem('A', 'one'), userItem('A', 'two', { itemId: 'case-43' })],
      A,
    );
    assert.ok(r.ok);
    assert.equal(r.value.indexedItems, 2);
    assert.deepEqual(r.value.notes, [
      {
        itemId: 'case-42',
        note: 'batch-embedding-failed',
        detail: 'embed down',
      },
      {
        itemId: 'case-43',
        note: 'batch-embedding-failed',
        detail: 'embed down',
      },
    ]);
  });

  it('a store that throws on write → the Result error with its code (index and remove)', async () => {
    const bound = profile().bind({ key: 'shared', user: throwingWriter() });
    const idx = await bound.index([userItem('A', 'x')], A);
    // The store's throw (out of `writer()`) is the call's Result error, its code kept — never a rejection.
    assert.ok(!idx.ok);
    assert.equal(idx.error.code, 'UPSERT_ERROR');
    const rm = await bound.remove(
      [{ itemId: 'case-42', owner: { scope: 'user', userId: 'A' } }],
      A,
    );
    assert.ok(!rm.ok);
    assert.equal(rm.error.code, 'UPSERT_ERROR');
  });

  it("a rejecting groups.writable → the call's Result error, nothing written", async () => {
    const global = new InMemoryRag();
    const groups: ISharedItemGroups = {
      readable: async () => [],
      writable: async () => {
        throw new RagError('authz down', 'AUTHZ_DOWN');
      },
    };
    const bound = profile().bind({ key: 'shared', global, groups });
    const r = await bound.index(
      [
        { itemId: 'pub', visibility: { scope: 'global' }, text: 'public' },
        {
          itemId: 'g',
          visibility: { scope: 'group', groupId: 'g1' },
          text: 'g',
        },
      ],
      A,
    );
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'AUTHZ_DOWN');
    const pub = await global.getById(
      recordId({ scope: 'global' }, 'pub', 'item', 0),
    );
    assert.ok(pub.ok && pub.value === null);
  });

  it('a rejecting groups.readable → retrieval and get return the Result error (never a rejection)', async () => {
    const global = new InMemoryRag();
    const groups: ISharedItemGroups = {
      readable: async () => {
        throw new RagError('authz down', 'AUTHZ_DOWN');
      },
      writable: async () => undefined,
    };
    const bound = profile().bind({ key: 'shared', global, groups });
    const r = await retrieve(bound, 'needle', A);
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'AUTHZ_DOWN');
    const g = await bound.get(
      { itemId: 'g', owner: { scope: 'group', groupId: 'g1' } },
      A,
    );
    assert.ok(!g.ok);
    assert.equal(g.error.code, 'AUTHZ_DOWN');
  });

  it('remove checks every ref before deleting anything', async () => {
    const user = new InMemoryRag();
    const bound = profile().bind({ key: 'shared', user });
    await bound.index([userItem('A', 'mine')], A);
    const rm = await bound.remove(
      [
        { itemId: 'case-42', owner: { scope: 'user', userId: 'A' } },
        { itemId: 'case-42', owner: { scope: 'user', userId: 'B' } },
      ],
      A,
    );
    assert.ok(!rm.ok && rm.error.code === 'OWNER_MISMATCH');
    const mine = await user.getById(
      recordId({ scope: 'user', userId: 'A' }, 'case-42', 'item', 0),
    );
    assert.ok(mine.ok && mine.value !== null, 'the own item is not removed');
  });

  it('remove of an own item deletes it; a ref with no partition is refused', async () => {
    const user = new InMemoryRag();
    const bound = profile().bind({ key: 'shared', user });
    await bound.index(
      [userItem('A', 'mine', { records: [{ kind: 'symptom', text: 's' }] })],
      A,
    );
    const rm = await bound.remove(
      [{ itemId: 'case-42', owner: { scope: 'user', userId: 'A' } }],
      A,
    );
    assert.ok(rm.ok);
    assert.equal(rm.value, 2, 'the symptom record and the canonical');
    const gone = await user.getById(
      recordId({ scope: 'user', userId: 'A' }, 'case-42', 'item', 0),
    );
    assert.ok(gone.ok && gone.value === null);
    const noGlobal = await bound.remove(
      [{ itemId: 'pub', owner: { scope: 'global' } }],
      A,
    );
    assert.ok(!noGlobal.ok && noGlobal.error.code === 'NO_PARTITION');
  });

  it('bound.rag.healthCheck probes the user and global partitions; a failing one fails it', async () => {
    const user = new InMemoryRag();
    const global: IRag = {
      query: async () => ({ ok: true, value: [] }),
      getById: async () => ({ ok: true, value: null }),
      healthCheck: async () => ({
        ok: false,
        error: new RagError('global down', 'CONNECTION_ERROR'),
      }),
    };
    const ok = await profile().bind({ key: 'shared', user }).rag.healthCheck();
    assert.ok(ok.ok);
    const bad = await profile()
      .bind({ key: 'shared', user, global })
      .rag.healthCheck();
    assert.ok(!bad.ok && bad.error.code === 'CONNECTION_ERROR');
  });

  it("the health probe finds the profile's reranker through the store's strategy (D97)", () => {
    const reranker: IReranker = {
      rerank: async (_q, c) => ({ ok: true, value: c }),
    };
    const bound = new SharedItemsProfile({
      maxRecordsPerItem: 2,
      collapse: new MaxScoreCollapse(),
      rerank: { reranker },
    }).bind({ key: 'shared', user: new InMemoryRag() });
    const held = heldRerankers(undefined, { shared: bound.rag });
    assert.equal(held.length, 1);
    assert.equal(held[0].reranker, reranker);
    assert.equal(held[0].name, 'store:shared');
  });

  it('no pool → ItemPool(): the caller k items per source (D56)', async () => {
    const seenK: number[] = [];
    const bound = new SharedItemsProfile({
      maxRecordsPerItem: 3,
      collapse: new MaxScoreCollapse(),
    }).bind({ key: 'shared', user: matchesOnly(new InMemoryRag(), seenK) });
    const r = await retrieve(bound, 'needle', A);
    assert.ok(r.ok);
    assert.deepEqual(seenK, [new ItemPool().recordsToFetch(5, 3)]);
    assert.deepEqual(seenK, [15]);
  });

  it('maxRecordsPerItem must be a positive integer', () => {
    assert.throws(
      () =>
        new SharedItemsProfile({
          maxRecordsPerItem: 0,
          collapse: new MaxScoreCollapse(),
        }),
      /maxRecordsPerItem/,
    );
  });
});

describe('SharedItemsProfile — partitions together (fix round 1)', () => {
  it('one item id in the user, global and group partitions: three items, each whole, read per caller', async () => {
    const user = new InMemoryRag();
    const global = new InMemoryRag();
    const group = new InMemoryRag();
    // A and B may both read (and write) g1.
    const groups: ISharedItemGroups = {
      readable: async () => [{ groupId: 'g1', rag: matchesOnly(group) }],
      writable: async (id) => (id === 'g1' ? group : undefined),
    };
    const bound = profile().bind({
      key: 'shared',
      user: matchesOnly(user),
      global: matchesOnly(global),
      groups,
    });
    const r = await bound.index(
      [
        userItem('A', 'needle of A'),
        {
          itemId: 'case-42',
          visibility: { scope: 'global' },
          text: 'needle for everyone',
        },
        {
          itemId: 'case-42',
          visibility: { scope: 'group', groupId: 'g1' },
          text: 'needle of group g1',
        },
      ],
      A,
    );
    assert.ok(r.ok && r.value.indexedItems === 3, JSON.stringify(r));
    const owners = (
      xs: { text: string; metadata: Record<string, unknown> }[],
    ) =>
      xs
        .map((x) => [
          x.metadata.visibility,
          x.metadata.userId ?? x.metadata.groupId ?? null,
          x.text,
        ])
        .sort();
    const asA = await retrieve(bound, 'needle', A);
    assert.ok(asA.ok);
    assert.equal(asA.value.length, 3);
    assert.deepEqual(owners(asA.value), [
      ['global', null, 'needle for everyone'],
      ['group', 'g1', 'needle of group g1'],
      ['user', 'A', 'needle of A'],
    ]);
    const asB = await retrieve(bound, 'needle', B);
    assert.ok(asB.ok);
    assert.deepEqual(owners(asB.value), [
      ['global', null, 'needle for everyone'],
      ['group', 'g1', 'needle of group g1'],
    ]);
    const gGlobal = await bound.get(
      { itemId: 'case-42', owner: { scope: 'global' } },
      B,
    );
    assert.ok(gGlobal.ok && gGlobal.value?.text === 'needle for everyone');
    const gGroup = await bound.get(
      { itemId: 'case-42', owner: { scope: 'group', groupId: 'g1' } },
      B,
    );
    assert.ok(gGroup.ok && gGroup.value?.text === 'needle of group g1');
    assert.equal(gGroup.value?.metadata.groupId, 'g1');
    const notMine = await bound.get(
      { itemId: 'case-42', owner: { scope: 'group', groupId: 'g2' } },
      B,
    );
    assert.ok(notMine.ok && notMine.value === null, 'g2 is not readable');
  });

  it('an unknown visibility is a typed refusal, never a write into no store', async () => {
    const user = new InMemoryRag();
    const bound = profile().bind({ key: 'shared', user });
    const r = await bound.index(
      [
        {
          itemId: 's',
          // A session visibility does not type-check; it can still arrive at runtime.
          visibility: { scope: 'session', sessionId: 'x' } as never,
          text: 's',
        },
      ],
      A,
    );
    assert.ok(r.ok, JSON.stringify(r));
    assert.deepEqual(r.value.failedItems, [
      { itemId: 's', reason: 'unknown-visibility' },
    ]);
  });

  it('the global and group partitions keep ragFilter.namespace (store identity); only identity keys are dropped', async () => {
    const global = new InMemoryRag({ namespace: 'N1' });
    const bound = profile().bind({
      key: 'shared',
      global: matchesOnly(global),
    });
    const w = await bound.index(
      [{ itemId: 'pub', visibility: { scope: 'global' }, text: 'needle' }],
      A,
    );
    assert.ok(w.ok && w.value.indexedItems === 1);
    const n2 = await retrieve(bound, 'needle', {
      userId: 'A',
      ragFilter: { namespace: 'N2', userId: 'A' },
    });
    assert.ok(n2.ok);
    assert.deepEqual(n2.value, [], 'a caller in N2 does not see N1');
    const n1 = await retrieve(bound, 'needle', {
      userId: 'A',
      ragFilter: { namespace: 'N1', userId: 'A' },
    });
    assert.ok(n1.ok);
    assert.deepEqual(
      n1.value.map((x) => x.metadata.id),
      ['pub'],
      'the userId filter is dropped for the global partition; the namespace is kept',
    );
  });
});
