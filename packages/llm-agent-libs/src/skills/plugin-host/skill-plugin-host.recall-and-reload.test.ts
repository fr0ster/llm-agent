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
import { SkillsIncompatibleError } from '@mcp-abap-adt/llm-agent';
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

const SERVE_BASE = {
  embedder: embedder as never,
  embeddingSpaceId: 'sp',
  retrievalSchemaVersion: 1,
  dimension: 3,
};

/** Seed an in-memory provider with one committed generation for `group`. */
async function seedProvider(
  group: string,
  records: SkillRecord[],
  manifest = {
    embeddingSpaceId: 'sp',
    dimension: 3,
    retrievalSchemaVersion: 1,
  },
) {
  const provider = makeInMemoryStoreProvider({ embed });
  const generation = `${group}#g0`;
  await provider._seed(
    generation,
    records.map((r) => ({ record: r, vector: hash3(r.retrievalText) })),
  );
  await provider.publishCatalog('c0', [
    {
      collection: info(group),
      sources: ['seed'],
      generation,
      manifest,
    },
  ] as CatalogEntry[]);
  return provider;
}

/** Seed an in-memory provider with one committed generation per named group. */
async function seedProviderMulti(
  groups: Array<{ group: string; records: SkillRecord[] }>,
  manifest = {
    embeddingSpaceId: 'sp',
    dimension: 3,
    retrievalSchemaVersion: 1,
  },
) {
  const provider = makeInMemoryStoreProvider({ embed });
  const entries: CatalogEntry[] = [];
  for (const { group, records } of groups) {
    const generation = `${group}#g0`;
    await provider._seed(
      generation,
      records.map((r) => ({ record: r, vector: hash3(r.retrievalText) })),
    );
    entries.push({
      collection: info(group),
      sources: ['seed'],
      generation,
      manifest,
    });
  }
  await provider.publishCatalog('c0', entries);
  return provider;
}

// 0a ------------------------------------------------------------------------
test('recall-only: NO serveCollections → serves ALL cataloged collections', async () => {
  const provider = await seedProviderMulti([
    { group: 'a', records: [rec('a:1', 'seed', 'a', 'alpha record')] },
    { group: 'b', records: [rec('b:1', 'seed', 'b', 'beta record')] },
  ]);

  // serveCollections OMITTED entirely → derive all from the catalog.
  const host = makeSkillPluginHost({
    ...SERVE_BASE,
    backendProvider: provider.asBackendProvider(),
  });

  const res = await host.load();
  assert.equal(res.ok, true);
  assert.deepEqual([...res.committed].sort(), ['a', 'b']);

  assert.deepEqual(
    host
      .groups()
      .map((g) => g.group)
      .sort(),
    ['a', 'b'],
  );

  const hits = await host
    .rag('a')
    .query('alpha record', { k: 5, threshold: 0 });
  assert.ok(hits.some((h) => h.record.id === 'a:1'));
});

// 0b ------------------------------------------------------------------------
test('recall-only: explicit serveCollections → serves only the named subset', async () => {
  const provider = await seedProviderMulti([
    { group: 'a', records: [rec('a:1', 'seed', 'a', 'alpha record')] },
    { group: 'b', records: [rec('b:1', 'seed', 'b', 'beta record')] },
  ]);

  const host = makeSkillPluginHost({
    ...SERVE_BASE,
    backendProvider: provider.asBackendProvider(),
    serveCollections: ['a'],
  });

  await host.load();
  assert.deepEqual(
    host.groups().map((g) => g.group),
    ['a'],
  );
});

// 1 -------------------------------------------------------------------------
test('recall-only: load() validates serveCollections + eager compat; groups()/rag() from catalog', async () => {
  const provider = await seedProvider('g1', [
    rec('g1:a', 'seed', 'g1', 'alpha record'),
  ]);

  const host = makeSkillPluginHost({
    ...SERVE_BASE,
    backendProvider: provider.asBackendProvider(),
    serveCollections: ['g1'],
  });

  const res = await host.load();
  assert.equal(res.ok, true);
  assert.deepEqual(res.committed, ['g1']);
  assert.deepEqual(res.omitted, []);
  assert.deepEqual(res.tombstoned, []);

  assert.deepEqual(
    host.groups().map((g) => g.group),
    ['g1'],
  );

  const hits = await host
    .rag('g1')
    .query('alpha record', { k: 5, threshold: 0 });
  assert.ok(hits.some((h) => h.record.id === 'g1:a'));
});

// 2 -------------------------------------------------------------------------
test('recall-only: serveCollections naming an absent collection → load() throws (config error)', async () => {
  const provider = await seedProvider('g1', [
    rec('g1:a', 'seed', 'g1', 'alpha'),
  ]);

  const host = makeSkillPluginHost({
    ...SERVE_BASE,
    backendProvider: provider.asBackendProvider(),
    serveCollections: ['missing'],
  });

  await assert.rejects(() => host.load(), /serveCollections/);
});

// 3 -------------------------------------------------------------------------
test('recall-only: incompatible serving embeddingSpaceId → load() throws (eager)', async () => {
  // Seed manifest with embeddingSpaceId 'sp'; serve with a different one → incompatible.
  const provider = await seedProvider('g1', [
    rec('g1:a', 'seed', 'g1', 'alpha'),
  ]);

  const host = makeSkillPluginHost({
    ...SERVE_BASE,
    embeddingSpaceId: 'OTHER-SPACE',
    backendProvider: provider.asBackendProvider(),
    serveCollections: ['g1'],
  });

  await assert.rejects(
    () => host.load(),
    (e) => e instanceof SkillsIncompatibleError,
  );
});

// 4 -------------------------------------------------------------------------
test('serving reload SAME set, new generations → succeeds and rotates', async () => {
  const provider = makeInMemoryStoreProvider({ embed });

  const mkHost = (body: string) =>
    makeSkillPluginHost({
      ...SERVE_BASE,
      storeProvider: provider,
      sources: [
        {
          id: 's1',
          source: makeStubSource({
            collections: [info('c1')],
            records: [rec('c1:a', 's1', 'c1', body)],
          }),
        },
      ],
    });

  // First load registers the served set {c1}.
  const host = mkHost('v1 body');
  await host.load();
  const gen1 = (await provider.readCatalog()).entries.find(
    (e) => e.collection.group === 'c1',
  )?.generation;

  // Reload on the SAME host, SAME set → new generation, no throw.
  const res = await host.load();
  assert.equal(res.ok, true);
  assert.deepEqual(res.committed, ['c1']);
  const gen2 = (await provider.readCatalog()).entries.find(
    (e) => e.collection.group === 'c1',
  )?.generation;
  assert.notEqual(gen1, gen2); // rotated
});

// 5 -------------------------------------------------------------------------
test('serving reload LOCAL change (sources resolve a new collection) → throws, no build/publish', async () => {
  // A host whose source set changes between loads via a toggling stub: first load resolves
  // {c1} (registers the served set), the second resolves {c1,c2} (a LOCAL change).
  let loadNo = 0;
  const togglingSource: ISkillSource = {
    async acquire(): Promise<SkillIngestResult> {
      loadNo++;
      if (loadNo === 1) {
        return {
          collections: [info('c1')],
          records: [rec('c1:a', 'sX', 'c1', 'alpha')],
        };
      }
      return {
        collections: [info('c1'), info('c2')],
        records: [
          rec('c1:a', 'sX', 'c1', 'alpha'),
          rec('c2:a', 'sX', 'c2', 'beta'),
        ],
      };
    },
  };
  const provider2 = makeInMemoryStoreProvider({ embed });
  let begin2 = 0;
  let publish2 = 0;
  const fg2 = provider2.forGroup.bind(provider2);
  provider2.forGroup = (group: string): ISkillsStore => {
    const store = fg2(group);
    return {
      ...store,
      async beginGeneration() {
        begin2++;
        return store.beginGeneration();
      },
    };
  };
  const pub2 = provider2.publishCatalog.bind(provider2);
  provider2.publishCatalog = async (rev, entries, options) => {
    publish2++;
    return pub2(rev, entries, options);
  };

  const reloadHost = makeSkillPluginHost({
    ...SERVE_BASE,
    storeProvider: provider2,
    sources: [{ id: 'sX', source: togglingSource }],
  });
  await reloadHost.load(); // registers {c1}
  const beginAfterFirst = begin2;
  const publishAfterFirst = publish2;
  const catBeforeReload = await provider2.readCatalog();

  // Second load resolves {c1,c2} → LOCAL change → guard throws BEFORE any build/publish.
  await assert.rejects(
    () => reloadHost.load(),
    /served collection set changed/i,
  );
  assert.equal(begin2, beginAfterFirst); // NO new generation built
  assert.equal(publish2, publishAfterFirst); // NO publish
  // Catalog unchanged.
  assert.deepEqual(
    (await provider2.readCatalog()).catalogRevision,
    catBeforeReload.catalogRevision,
  );
});

// 6 -------------------------------------------------------------------------
test('serving reload OUT-OF-BAND change (active catalog grew) → throws; external collection NOT tombstoned', async () => {
  const provider = makeInMemoryStoreProvider({ embed });

  let publishCalls = 0;
  const origPublish = provider.publishCatalog.bind(provider);
  provider.publishCatalog = async (rev, entries, options) => {
    publishCalls++;
    return origPublish(rev, entries, options);
  };

  // Serving host registers {c1}.
  const host = makeSkillPluginHost({
    ...SERVE_BASE,
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
  await host.load(); // registers {c1}
  const publishAfterFirst = publishCalls;

  // OUT-OF-BAND: a separate ingest adds c2 to the active catalog.
  const ingest = makeSkillPluginHost({
    ...SERVE_BASE,
    storeProvider: provider,
    servingMode: false,
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
  await ingest.load();
  const catWithBoth = await provider.readCatalog();
  assert.deepEqual(catWithBoth.entries.map((e) => e.collection.group).sort(), [
    'c1',
    'c2',
  ]);
  const publishAfterIngest = publishCalls;

  // Serving host reloads: its desired stays {c1} but active catalog is now {c1,c2} →
  // OUT-OF-BAND mismatch → guard throws BEFORE any publish.
  await assert.rejects(() => host.load(), /served collection set changed/i);
  assert.equal(publishCalls, publishAfterIngest); // serving host published NOTHING
  assert.ok(publishAfterFirst <= publishAfterIngest); // sanity

  // c2 is NOT tombstoned — it still serves (the externally-added collection survives).
  const cat = await provider.readCatalog();
  const c2 = cat.entries.find((e) => e.collection.group === 'c2');
  assert.ok(c2 && !c2.tombstone);
  const c2hits = await ingest.rag('c2').query('beta', { k: 5, threshold: 0 });
  assert.ok(c2hits.some((h) => h.record.id === 'c2:a'));
});

// 7 -------------------------------------------------------------------------
test('groups()/rag(): one group → rag() defaults; several → rag() throws; inactive group serves []', async () => {
  // One group: rag() with no arg resolves it.
  {
    const provider = await seedProvider('g1', [
      rec('g1:a', 'seed', 'g1', 'alpha'),
    ]);
    const host = makeSkillPluginHost({
      ...SERVE_BASE,
      backendProvider: provider.asBackendProvider(),
      serveCollections: ['g1'],
    });
    await host.load();
    const hits = await host.rag().query('alpha', { k: 5, threshold: 0 });
    assert.ok(hits.some((h) => h.record.id === 'g1:a'));
    // An inactive/unknown group serves [] (does NOT throw).
    const none = await host.rag('nonexistent').query('alpha', {
      k: 5,
      threshold: 0,
    });
    assert.equal(none.length, 0);
  }
  // Several groups: rag() with no arg throws.
  {
    const provider = makeInMemoryStoreProvider({ embed });
    // seed two collections.
    await provider._seed('g1#g0', [
      { record: rec('g1:a', 'seed', 'g1', 'alpha'), vector: hash3('alpha') },
    ]);
    await provider._seed('g2#g0', [
      { record: rec('g2:a', 'seed', 'g2', 'beta'), vector: hash3('beta') },
    ]);
    const manifest = {
      embeddingSpaceId: 'sp',
      dimension: 3,
      retrievalSchemaVersion: 1,
    };
    await provider.publishCatalog('c0', [
      {
        collection: info('g1'),
        sources: ['seed'],
        generation: 'g1#g0',
        manifest,
      },
      {
        collection: info('g2'),
        sources: ['seed'],
        generation: 'g2#g0',
        manifest,
      },
    ] as CatalogEntry[]);

    const host = makeSkillPluginHost({
      ...SERVE_BASE,
      backendProvider: provider.asBackendProvider(),
      serveCollections: ['g1', 'g2'],
    });
    await host.load();
    assert.throws(() => host.rag(), /name the group/);
  }
});
