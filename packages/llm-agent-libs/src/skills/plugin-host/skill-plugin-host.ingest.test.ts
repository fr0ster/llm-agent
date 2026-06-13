import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  CallOptions,
  CatalogEntry,
  IEmbedResult,
  ISkillSource,
  ISkillsStore,
  SkillGroupInfo,
  SkillIngestResult,
  SkillRecord,
} from '@mcp-abap-adt/llm-agent';
import { CatalogCasError } from '@mcp-abap-adt/llm-agent';
import { makeInMemoryStoreProvider } from './in-memory-store.js';
import { makeSkillPluginHost } from './skill-plugin-host.js';

// Deterministic 3-dim vector from text — lets the in-memory store embed with no real embedder.
function hash3(text: string): number[] {
  const v = [0, 0, 0];
  for (let i = 0; i < text.length; i++) {
    v[i % 3] += text.charCodeAt(i);
  }
  return v;
}

// In-memory store provider embed: text → vector (number[]).
const embed = async (text: string): Promise<number[]> => hash3(text);
// Host serving embedder: text → IEmbedResult.
const embedder = {
  async embed(text: string): Promise<IEmbedResult> {
    return { vector: hash3(text) };
  },
};

function rec(
  id: string,
  sourceId: string,
  group: string,
  content: string,
): SkillRecord {
  return {
    id,
    sourceId,
    group,
    name: id,
    retrievalText: content,
    content,
    provenance: id,
  };
}

function info(group: string, description = `desc-${group}`): SkillGroupInfo {
  return { group, description, collection: group };
}

/** A stub source that returns a fixed result or throws on acquire. */
function makeStubSource(
  result: SkillIngestResult | (() => never),
): ISkillSource {
  return {
    async acquire(_options?: CallOptions): Promise<SkillIngestResult> {
      if (typeof result === 'function') return result();
      return result;
    },
  };
}

const HOST_BASE = {
  embedder: embedder as never,
  embeddingSpaceId: 'sp',
  retrievalSchemaVersion: 1,
  dimension: 3,
};

// 1 -------------------------------------------------------------------------
test('commits all desired collections in ONE publishCatalog', async () => {
  const provider = makeInMemoryStoreProvider({ embed });
  let publishCount = 0;
  const origPublish = provider.publishCatalog.bind(provider);
  provider.publishCatalog = async (rev, entries, options) => {
    publishCount++;
    return origPublish(rev, entries, options);
  };

  const host = makeSkillPluginHost({
    ...HOST_BASE,
    storeProvider: provider,
    sources: [
      {
        id: 's1',
        source: makeStubSource({
          collections: [info('c1')],
          records: [rec('c1:a', 's1', 'c1', 'alpha record')],
        }),
      },
      {
        id: 's2',
        source: makeStubSource({
          collections: [info('c2')],
          records: [rec('c2:a', 's2', 'c2', 'beta record')],
        }),
      },
    ],
  });

  const res = await host.load();
  assert.equal(res.ok, true);
  assert.deepEqual([...res.committed].sort(), ['c1', 'c2']);
  assert.equal(publishCount, 1);
  assert.deepEqual(
    host
      .groups()
      .map((g) => g.group)
      .sort(),
    ['c1', 'c2'],
  );
  const hits = await host
    .rag('c1')
    .query('alpha record', { k: 5, threshold: 0 });
  assert.ok(hits.some((h) => h.record.id === 'c1:a'));
});

// 2 -------------------------------------------------------------------------
test('multi-source merge: union records + ownership; conflicting descriptions throw', async () => {
  // Same description → merged.
  {
    const provider = makeInMemoryStoreProvider({ embed });
    const host = makeSkillPluginHost({
      ...HOST_BASE,
      storeProvider: provider,
      sources: [
        {
          id: 's1',
          source: makeStubSource({
            collections: [info('c1', 'shared')],
            records: [rec('c1:a', 's1', 'c1', 'aaa')],
          }),
        },
        {
          id: 's2',
          source: makeStubSource({
            collections: [info('c1', 'shared')],
            records: [rec('c1:b', 's2', 'c1', 'bbb')],
          }),
        },
      ],
    });
    const res = await host.load();
    assert.equal(res.ok, true);
    assert.deepEqual(res.committed, ['c1']);
    const hits = await host.rag('c1').query('aaa', { k: 5, threshold: 0 });
    assert.equal(hits.length, 2); // union of both sources' records
  }
  // Different descriptions → throw.
  {
    const provider = makeInMemoryStoreProvider({ embed });
    const host = makeSkillPluginHost({
      ...HOST_BASE,
      storeProvider: provider,
      sources: [
        {
          id: 's1',
          source: makeStubSource({
            collections: [info('c1', 'A')],
            records: [rec('c1:a', 's1', 'c1', 'aaa')],
          }),
        },
        {
          id: 's2',
          source: makeStubSource({
            collections: [info('c1', 'B')],
            records: [rec('c1:b', 's2', 'c1', 'bbb')],
          }),
        },
      ],
    });
    await assert.rejects(() => host.load());
  }
});

// 3 -------------------------------------------------------------------------
test('carry-forward publishes a NEW generation', async () => {
  const provider = makeInMemoryStoreProvider({ embed });

  // Load A: c1 fed by s1 + s2, both succeed.
  const sourcesOk = [
    {
      id: 's1',
      source: makeStubSource({
        collections: [info('c1')],
        records: [rec('c1:s1', 's1', 'c1', 's1 body')],
      }),
    },
    {
      id: 's2',
      source: makeStubSource({
        collections: [info('c1')],
        records: [rec('c1:s2', 's2', 'c1', 's2 body')],
      }),
    },
  ];
  const hostA = makeSkillPluginHost({
    ...HOST_BASE,
    storeProvider: provider,
    sources: sourcesOk,
  });
  await hostA.load();
  const priorAfterA = await provider.readCatalog();
  const priorGen = priorAfterA.entries.find(
    (e) => e.collection.group === 'c1',
  )?.generation;

  // Load B: s2 throws → carry-forward of s2's records into a NEW generation.
  const hostB = makeSkillPluginHost({
    ...HOST_BASE,
    storeProvider: provider,
    strict: false,
    sources: [
      {
        id: 's1',
        source: makeStubSource({
          collections: [info('c1')],
          records: [rec('c1:s1', 's1', 'c1', 's1 body refreshed')],
        }),
      },
      {
        id: 's2',
        source: makeStubSource(() => {
          throw new Error('s2 down');
        }),
      },
    ],
  });
  const res = await hostB.load();
  assert.equal(res.ok, true);
  const afterB = await provider.readCatalog();
  const newGen = afterB.entries.find(
    (e) => e.collection.group === 'c1',
  )?.generation;
  assert.notEqual(newGen, priorGen); // a NEW generation, not the prior pointer
  // The new generation has s1 (refreshed) + s2 (carried forward).
  const hits = await hostB.rag('c1').query('body', { k: 10, threshold: 0 });
  const ids = hits.map((h) => h.record.id).sort();
  assert.deepEqual(ids, ['c1:s1', 'c1:s2']);
});

// 4 -------------------------------------------------------------------------
test('first-load build failure with NO prior → omit + partial result', async () => {
  // Provider where forGroup('c2').upsert always throws (no prior generation exists).
  const provider = makeInMemoryStoreProvider({ embed });
  const orig = provider.forGroup.bind(provider);
  provider.forGroup = (group: string): ISkillsStore => {
    const store = orig(group);
    if (group === 'c2') {
      return {
        ...store,
        async upsert() {
          throw new Error('c2 upsert fail');
        },
      };
    }
    return store;
  };

  const host = makeSkillPluginHost({
    ...HOST_BASE,
    storeProvider: provider,
    sources: [
      {
        id: 's1',
        source: makeStubSource({
          collections: [info('c1')],
          records: [rec('c1:a', 's1', 'c1', 'alpha')],
        }),
      },
      {
        id: 's2',
        source: makeStubSource({
          collections: [info('c2')],
          records: [rec('c2:a', 's2', 'c2', 'beta')],
        }),
      },
    ],
  });

  const res = await host.load();
  assert.equal(res.ok, false);
  assert.deepEqual(res.committed, ['c1']);
  assert.equal(res.omitted.length, 1);
  assert.equal(res.omitted[0].group, 'c2');
  // c1 committed and serves; c2 serves nothing.
  assert.deepEqual(
    host.groups().map((g) => g.group),
    ['c1'],
  );
  const c2hits = await host.rag('c2').query('beta', { k: 5, threshold: 0 });
  assert.equal(c2hits.length, 0);
});

// 5 -------------------------------------------------------------------------
test('collection-set reconciliation: removed collection tombstoned now, reclaimed next load', async () => {
  // servingMode:false so the reload guard does not block the set-change.
  const provider = makeInMemoryStoreProvider({ embed });
  let dropCalls: string[] = [];
  const origDrop = provider.dropCollection.bind(provider);
  provider.dropCollection = async (group, options) => {
    dropCalls.push(group);
    return origDrop(group, options);
  };

  const mkHost = (sources: { id: string; source: ISkillSource }[]) =>
    makeSkillPluginHost({
      ...HOST_BASE,
      storeProvider: provider,
      servingMode: false,
      sources,
    });

  // Load A: {c1, c2}
  const hostA = mkHost([
    {
      id: 's1',
      source: makeStubSource({
        collections: [info('c1')],
        records: [rec('c1:a', 's1', 'c1', 'alpha')],
      }),
    },
    {
      id: 's2',
      source: makeStubSource({
        collections: [info('c2')],
        records: [rec('c2:a', 's2', 'c2', 'beta')],
      }),
    },
  ]);
  await hostA.load();

  // Loads B and C run on the SAME host: deferred reclaim is per-host-instance state
  // (load B schedules c2's drop; load C — the next load() on that host — reclaims it).
  const hostBC = mkHost([
    {
      id: 's1',
      source: makeStubSource({
        collections: [info('c1')],
        records: [rec('c1:a', 's1', 'c1', 'alpha')],
      }),
    },
  ]);

  // Load B: {c1} only.
  const resB = await hostBC.load();
  assert.deepEqual(resB.committed, ['c1']);
  assert.deepEqual(resB.tombstoned, ['c2']);
  // Immediately after B: groups()={c1}, rag('c2') empty.
  assert.deepEqual(
    hostBC.groups().map((g) => g.group),
    ['c1'],
  );
  assert.equal(
    (await hostBC.rag('c2').query('beta', { k: 5, threshold: 0 })).length,
    0,
  );
  assert.equal(dropCalls.length, 0); // not physically dropped yet (deferred)

  // Load C: reclaims c2 (dropCollection runs at the start).
  dropCalls = [];
  await hostBC.load();
  assert.deepEqual(dropCalls, ['c2']);
});

// 6 -------------------------------------------------------------------------
test('partial-commit orphan cleanup (P1.4)', async () => {
  // c2 has a PRIOR generation; its second build fails mid-way (upsert throws once) →
  // commit keeps c2's prior pointer; the freshly-built gen is discarded in the finally.
  const provider = makeInMemoryStoreProvider({ embed });

  let c2UpsertCalls = 0;
  const discarded: string[] = [];
  const beganC2: string[] = [];
  const orig = provider.forGroup.bind(provider);
  provider.forGroup = (group: string): ISkillsStore => {
    const store = orig(group);
    if (group !== 'c2') return store;
    return {
      ...store,
      async beginGeneration() {
        const g = await store.beginGeneration();
        beganC2.push(g.generation);
        return g;
      },
      async upsert(generation, records, options) {
        c2UpsertCalls++;
        if (c2UpsertCalls === 2) throw new Error('c2 second upsert fail');
        return store.upsert(generation, records, options);
      },
      async discardGeneration(generation) {
        discarded.push(generation);
        return store.discardGeneration(generation);
      },
    };
  };

  const mkSources = () => [
    {
      id: 's1',
      source: makeStubSource({
        collections: [info('c1')],
        records: [rec('c1:a', 's1', 'c1', 'alpha')],
      }),
    },
    {
      id: 's2',
      source: makeStubSource({
        collections: [info('c2')],
        records: [rec('c2:a', 's2', 'c2', 'beta')],
      }),
    },
  ];

  // Load A: both succeed → c2 has a prior generation.
  const hostA = makeSkillPluginHost({
    ...HOST_BASE,
    storeProvider: provider,
    sources: mkSources(),
  });
  await hostA.load();
  const priorC2 = (await provider.readCatalog()).entries.find(
    (e) => e.collection.group === 'c2',
  )?.generation;
  assert.ok(priorC2);

  // Load B: c2's build fails mid (upsert throws) → falls back to prior pointer.
  const hostB = makeSkillPluginHost({
    ...HOST_BASE,
    storeProvider: provider,
    servingMode: false,
    sources: mkSources(),
  });
  const resB = await hostB.load();
  assert.equal(resB.ok, true); // committed===true (partial commit, c2 prior pointer kept)
  // The freshly-built (failed-mid) c2 generation was discarded even though committed===true.
  const builtMid = beganC2[beganC2.length - 1];
  assert.ok(discarded.includes(builtMid));
  // The committed catalog keeps c2's PRIOR pointer.
  const after = await provider.readCatalog();
  assert.equal(
    after.entries.find((e) => e.collection.group === 'c2')?.generation,
    priorC2,
  );
});

// 7 -------------------------------------------------------------------------
test('lost CAS → discard built gens + retry from fresh snapshot, then commit', async () => {
  const provider = makeInMemoryStoreProvider({ embed });
  let publishCalls = 0;
  const origPublish = provider.publishCatalog.bind(provider);
  provider.publishCatalog = async (rev, entries, options) => {
    publishCalls++;
    if (publishCalls === 1) throw new CatalogCasError('lost cas');
    return origPublish(rev, entries, options);
  };
  let beginCalls = 0;
  const origForGroup = provider.forGroup.bind(provider);
  provider.forGroup = (group: string): ISkillsStore => {
    const store = origForGroup(group);
    return {
      ...store,
      async beginGeneration() {
        beginCalls++;
        return store.beginGeneration();
      },
    };
  };

  const host = makeSkillPluginHost({
    ...HOST_BASE,
    storeProvider: provider,
    sources: [
      {
        id: 's1',
        source: makeStubSource({
          collections: [info('c1')],
          records: [rec('c1:a', 's1', 'c1', 'alpha')],
        }),
      },
    ],
  });
  const res = await host.load();
  assert.equal(res.ok, true);
  assert.equal(publishCalls, 2); // first lost, second won
  assert.equal(beginCalls, 2); // a FRESH generation per attempt (no reuse)
});

// 8 -------------------------------------------------------------------------
test('exhausted CAS → throw, no orphans', async () => {
  const provider = makeInMemoryStoreProvider({ embed });
  // Seed a pre-existing committed generation directly.
  const seedGen = 'pre#g0';
  await provider._seed(seedGen, [
    { record: rec('pre:a', 'sp', 'pre', 'seed'), vector: hash3('seed') },
  ]);
  await provider.publishCatalog('c0', [
    {
      collection: info('pre'),
      sources: ['sp'],
      generation: seedGen,
      manifest: {
        embeddingSpaceId: 'sp',
        dimension: 3,
        retrievalSchemaVersion: 1,
      },
    },
  ] as CatalogEntry[]);

  const discarded: string[] = [];
  const origForGroup = provider.forGroup.bind(provider);
  provider.forGroup = (group: string): ISkillsStore => {
    const store = origForGroup(group);
    return {
      ...store,
      async discardGeneration(generation) {
        discarded.push(generation);
        return store.discardGeneration(generation);
      },
    };
  };
  provider.publishCatalog = async () => {
    throw new CatalogCasError('always lost');
  };

  const host = makeSkillPluginHost({
    ...HOST_BASE,
    storeProvider: provider,
    servingMode: false,
    catalogCasMaxAttempts: 3,
    sources: [
      {
        id: 's1',
        source: makeStubSource({
          collections: [info('c1')],
          records: [rec('c1:a', 's1', 'c1', 'alpha')],
        }),
      },
    ],
  });
  await assert.rejects(() => host.load());
  // The pre-existing committed generation survives; only built gens were discarded.
  const cat = await provider.readCatalog();
  assert.ok(cat.entries.some((e) => e.generation === seedGen));
  assert.ok(discarded.length >= 3); // each attempt's built gen discarded
  assert.ok(!discarded.includes(seedGen));
});

// 9 -------------------------------------------------------------------------
test('strict:true source failure → throw, nothing committed', async () => {
  const provider = makeInMemoryStoreProvider({ embed });
  let publishCalls = 0;
  const origPublish = provider.publishCatalog.bind(provider);
  provider.publishCatalog = async (rev, entries, options) => {
    publishCalls++;
    return origPublish(rev, entries, options);
  };

  const host = makeSkillPluginHost({
    ...HOST_BASE,
    storeProvider: provider,
    strict: true,
    sources: [
      {
        id: 's1',
        source: makeStubSource({
          collections: [info('c1')],
          records: [rec('c1:a', 's1', 'c1', 'alpha')],
        }),
      },
      {
        id: 's2',
        source: makeStubSource(() => {
          throw new Error('s2 down');
        }),
      },
    ],
  });
  await assert.rejects(() => host.load());
  assert.equal(publishCalls, 0);
  const cat = await provider.readCatalog();
  assert.equal(cat.entries.length, 0);
});
