import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CatalogCasError } from '@mcp-abap-adt/llm-agent';
import { makeInMemoryStoreProvider } from './in-memory-store.js';

const MANIFEST = {
  embeddingSpaceId: 'sp',
  dimension: 3,
  retrievalSchemaVersion: 1,
};
const rec = (id: string, group: string, vec: number[]) => ({
  record: {
    id,
    sourceId: 's',
    group,
    name: id,
    retrievalText: id,
    content: `c-${id}`,
    provenance: id,
  },
  vector: vec,
});

test('build inactive → publishCatalog activates → query + activeSnapshot from catalog', async () => {
  const p = makeInMemoryStoreProvider();
  const store = p.forGroup('g1');
  const { generation } = await store.beginGeneration();
  // upsert is embedding-agnostic here: the in-memory store accepts pre-vectorised rows via a test seam
  await p._seed(generation, [
    rec('a', 'g1', [1, 0, 0]),
    rec('b', 'g1', [0, 1, 0]),
  ]);
  // nothing serves yet
  assert.equal(await store.activeSnapshot(), null);
  const before = await p.readCatalog();
  await p.publishCatalog(before.catalogRevision, [
    {
      collection: { group: 'g1', description: 'd', collection: 'g1' },
      sources: ['s'],
      generation,
      manifest: MANIFEST,
    },
  ]);
  const snap = await store.activeSnapshot();
  assert.equal(snap?.revision, generation);
  assert.deepEqual(snap?.manifest, MANIFEST);
  const hits = await store.queryRevision(generation, [1, 0, 0], 1);
  assert.equal(hits[0].record.id, 'a');
});

test('publishCatalog CAS rejects a stale expectedRevision with CatalogCasError', async () => {
  const p = makeInMemoryStoreProvider();
  const r0 = (await p.readCatalog()).catalogRevision;
  await p.publishCatalog(r0, []); // bumps to r1
  await assert.rejects(
    () => p.publishCatalog(r0, []),
    (e) => e instanceof CatalogCasError,
  );
});

test('EXACT retention via lease: a generation pinned by activeSnapshot survives a concurrent reclaim until release', async () => {
  const p = makeInMemoryStoreProvider();
  const backend = p.forGroup('g1');
  const g = await backend.beginGeneration();
  await p._seed(g.generation, [rec('a', 'g1', [1, 0, 0])]);
  await p.publishCatalog((await p.readCatalog()).catalogRevision, [
    {
      collection: { group: 'g1', description: 'd', collection: 'g1' },
      sources: ['s'],
      generation: g.generation,
      manifest: MANIFEST,
    },
  ]);
  // a reader resolves (PINS) the generation...
  const snap = await backend.activeSnapshot();
  // ...then the catalog rotates it out AND a reclaim is attempted (simulating a concurrent load)
  await p.publishCatalog((await p.readCatalog()).catalogRevision, []); // retire g1
  await p.forGroup('g1').discardGeneration(snap!.revision); // reclaim attempt — DEFERRED (leased)
  // the in-flight reader's query STILL succeeds (no read-under-delete):
  assert.equal(
    (await backend.queryRevision(snap!.revision, [1, 0, 0], 1)).length,
    1,
  );
  // release the lease → the deferred reclaim now runs
  backend.release!(snap!.revision);
  await assert.rejects(
    () => backend.queryRevision(snap!.revision, [1, 0, 0], 1),
    /unknown generation/i,
  );
});

test('an ACTIVE generation is retained; dropCollection only reclaims a NON-active one', async () => {
  const p = makeInMemoryStoreProvider();
  const g = await p.forGroup('g1').beginGeneration();
  await p._seed(g.generation, [rec('a', 'g1', [1, 0, 0])]);
  const r0 = (await p.readCatalog()).catalogRevision;
  await p.publishCatalog(r0, [
    {
      collection: { group: 'g1', description: 'd', collection: 'g1' },
      sources: ['s'],
      generation: g.generation,
      manifest: MANIFEST,
    },
  ]);
  // dropCollection on an ACTIVE collection must NOT delete its served generation
  await p.dropCollection('g1');
  assert.equal(
    (await p.forGroup('g1').queryRevision(g.generation, [1, 0, 0], 1)).length,
    1,
  );
  // now retire g1 from the catalog (publish WITHOUT it) → the generation becomes non-active
  const r1 = (await p.readCatalog()).catalogRevision;
  await p.publishCatalog(r1, []);
  await p.dropCollection('g1'); // reclaims the now-non-active generation
  await assert.rejects(
    () => p.forGroup('g1').queryRevision(g.generation, [1, 0, 0], 1),
    /unknown generation|not found/i,
  );
});
