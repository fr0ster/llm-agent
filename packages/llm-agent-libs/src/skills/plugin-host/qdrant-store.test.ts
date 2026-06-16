import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CatalogEntry, CatalogSnapshot } from '@mcp-abap-adt/llm-agent';
import { CatalogCasError } from '@mcp-abap-adt/llm-agent';
import {
  type IPgPool,
  type IQdrantClient,
  makeInProcessCatalogStore,
  makePgCatalogReader,
  makePgCatalogStore,
  makeQdrantBackendProvider,
  makeQdrantClient,
  makeQdrantStoreProvider,
  pointId,
} from './qdrant-store.js';

const MANIFEST = {
  embeddingSpaceId: 'sp',
  dimension: 3,
  retrievalSchemaVersion: 1,
};

// deterministic 3-dim embed (like the other tests): hash text → unit-ish vector
const embed = async (text: string): Promise<number[]> => {
  let a = 0;
  let b = 0;
  let c = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (i % 3 === 0) a += code;
    else if (i % 3 === 1) b += code;
    else c += code;
  }
  return [a, b, c];
};

const rec = (id: string, group = 'g1', sourceId = 's') => ({
  id,
  sourceId,
  group,
  name: id,
  retrievalText: id,
  content: `c-${id}`,
  provenance: id,
});

function eq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// In-memory mock of IQdrantClient. Matches a subset of Qdrant filter semantics:
// filters here are flat objects { generation?, sourceId?: string[] }.
interface StoredPoint {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
}
function makeMockClient(): IQdrantClient & {
  _points: Map<string, StoredPoint>;
  _deleteCalls: number;
  _upsertWaits: boolean[];
} {
  const points = new Map<string, StoredPoint>();
  const counter = { deleteCalls: 0 };
  const upsertWaits: boolean[] = [];
  const matches = (
    p: StoredPoint,
    filter: Record<string, unknown>,
  ): boolean => {
    if (
      filter.generation !== undefined &&
      p.payload.generation !== filter.generation
    )
      return false;
    if (Array.isArray(filter.sourceId)) {
      if (!(filter.sourceId as string[]).includes(p.payload.sourceId as string))
        return false;
    }
    return true;
  };
  const cosine = (x: number[], y: number[]): number => {
    let dot = 0;
    let nx = 0;
    let ny = 0;
    for (let i = 0; i < x.length; i++) {
      dot += x[i] * y[i];
      nx += x[i] * x[i];
      ny += y[i] * y[i];
    }
    return nx && ny ? dot / (Math.sqrt(nx) * Math.sqrt(ny)) : 0;
  };
  return {
    _points: points,
    _upsertWaits: upsertWaits,
    get _deleteCalls() {
      return counter.deleteCalls;
    },
    async upsertPoints(pts, opts) {
      upsertWaits.push(opts?.wait === true);
      for (const p of pts) points.set(p.id, { ...p });
    },
    async deleteByFilter(filter) {
      counter.deleteCalls++;
      for (const [id, p] of [...points.entries()]) {
        if (matches(p, filter as Record<string, unknown>)) points.delete(id);
      }
    },
    async search(filter, vector, k) {
      return [...points.values()]
        .filter((p) => matches(p, filter as Record<string, unknown>))
        .map((p) => ({ payload: p.payload, score: cosine(vector, p.vector) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, k);
    },
    async scroll(filter, cursor) {
      const all = [...points.values()].filter((p) =>
        matches(p, filter as Record<string, unknown>),
      );
      // paginate in pages of 2 to exercise the cursor loop
      const start = cursor ? Number(cursor) : 0;
      const page = all.slice(start, start + 2);
      const nextStart = start + 2;
      return {
        points: page.map((p) => ({
          id: p.id,
          vector: p.vector,
          payload: p.payload,
        })),
        next: nextStart < all.length ? String(nextStart) : undefined,
      };
    },
  };
}

const fixedNow = () => 1_000_000;

function makeProvider(
  client: IQdrantClient,
  opts: {
    catalogStore?: ReturnType<typeof makeInProcessCatalogStore>;
    now?: () => number;
    retiredGraceMs?: number;
    orphanGraceMs?: number;
  } = {},
) {
  return makeQdrantStoreProvider({
    client,
    collection: 'skills',
    catalogStore: opts.catalogStore ?? makeInProcessCatalogStore(),
    embed,
    pointId,
    now: opts.now ?? fixedNow,
    retiredGraceMs: opts.retiredGraceMs ?? 30_000,
    orphanGraceMs: opts.orphanGraceMs ?? 3_600_000,
  });
}

test('point ids are deterministic UUIDv5 of generation:recordId', () => {
  const a = pointId('g0', 'r1');
  const b = pointId('g0', 'r1');
  const c = pointId('g1', 'r1');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(
    a,
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});

test('beginGeneration() returns DISTINCT, globally-unique ids (not a process-local counter), with the group prefix', async () => {
  const client = makeMockClient();
  // a FIXED clock would make a counter+timestamp id collide; a UUID suffix must not
  const p = makeProvider(client, { now: () => 42 });
  const store = p.forGroup('g1');
  const a = (await store.beginGeneration()).generation;
  const b = (await store.beginGeneration()).generation;
  assert.notEqual(a, b);
  assert.ok(a.startsWith('g1#'), `expected group prefix, got ${a}`);
  assert.ok(b.startsWith('g1#'), `expected group prefix, got ${b}`);
  // suffix is a UUID, not a `g<n>#<ts>` counter shape
  assert.match(
    a.slice('g1#'.length),
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});

test('discardGeneration: ACTIVE generation is never deleted; NON-active generation is deleted', async () => {
  const client = makeMockClient();
  const p = makeProvider(client);
  const store = p.forGroup('g1');

  // generation A: published → ACTIVE in the catalog
  const gActive = (await store.beginGeneration()).generation;
  await store.upsert(gActive, [rec('a')]);
  await p.publishCatalog((await p.readCatalog()).catalogRevision, [
    {
      collection: { group: 'g1', description: 'd', collection: 'skills' },
      sources: ['s'],
      generation: gActive,
      manifest: MANIFEST,
    },
  ]);

  // generation B: in-build, never published → NOT active
  const gInactive = (await store.beginGeneration()).generation;
  await store.upsert(gInactive, [rec('b')]);

  // discarding the ACTIVE one must be a no-op (no deleteByFilter, points kept)
  const before = client._deleteCalls;
  await store.discardGeneration(gActive);
  assert.equal(client._deleteCalls, before, 'must not call deleteByFilter');
  assert.ok(client._points.has(pointId(gActive, 'a')));

  // discarding the NON-active one deletes its points
  await store.discardGeneration(gInactive);
  assert.equal(client._deleteCalls, before + 1);
  assert.ok(!client._points.has(pointId(gInactive, 'b')));
  // and never touched the active generation
  assert.ok(client._points.has(pointId(gActive, 'a')));
});

test('build inactive → publishCatalog (store-generated rev) → queryRevision by gen → activeSnapshot from catalog', async () => {
  const client = makeMockClient();
  const p = makeProvider(client);
  const store = p.forGroup('g1');
  const { generation } = await store.beginGeneration();
  await store.upsert(generation, [rec('a'), rec('b')]);
  // nothing serves yet
  assert.equal(await store.activeSnapshot(), null);

  const before = await p.readCatalog();
  const entry: CatalogEntry = {
    collection: { group: 'g1', description: 'd', collection: 'skills' },
    sources: ['s'],
    generation,
    manifest: MANIFEST,
  };
  const snap = await p.publishCatalog(before.catalogRevision, [entry]);
  // store generated a (different) revision
  assert.notEqual(snap.catalogRevision, before.catalogRevision);

  const active = await store.activeSnapshot();
  assert.equal(active?.revision, generation);
  assert.deepEqual(active?.manifest, MANIFEST);

  const hits = await store.queryRevision(generation, await embed('a'), 1);
  assert.equal(hits[0].record.id, 'a');
  assert.equal(hits[0].record.content, 'c-a');
  assert.equal(hits[0].record.group, 'g1');
});

test('publishCatalog stale expected → CatalogCasError (in-process)', async () => {
  const client = makeMockClient();
  const p = makeProvider(client);
  const r0 = (await p.readCatalog()).catalogRevision;
  await p.publishCatalog(r0, []); // advances
  await assert.rejects(
    () => p.publishCatalog(r0, []),
    (e) => e instanceof CatalogCasError,
  );
});

test('makePgCatalogStore: stale expected (fake pool UPDATE rowCount 0) → CatalogCasError', async () => {
  // fake pool: read returns empty initial row; UPDATE always rowCount 0 → stale
  const pool = {
    async query(sql: string) {
      if (/^select/i.test(sql.trim())) return { rows: [], rowCount: 0 };
      if (/^insert/i.test(sql.trim())) return { rows: [], rowCount: 1 };
      // UPDATE ... WHERE revision=$expected → no match
      return { rows: [], rowCount: 0 };
    },
  };
  const store = makePgCatalogStore({ pool, table: 'skills_catalog' });
  await assert.rejects(
    () => store.casPublish('whatever', [], 123),
    (e) => e instanceof CatalogCasError,
  );
});

test('makePgCatalogStore: successful casPublish (fake pool UPDATE rowCount 1) returns committed snapshot', async () => {
  let stored: { revision: string; snapshot: CatalogSnapshot } | null = {
    revision: 'r-init',
    snapshot: { catalogRevision: 'r-init', entries: [], retired: [] },
  };
  const pool = {
    async query(sql: string, params?: unknown[]) {
      const s = sql.trim();
      if (/^select/i.test(s)) {
        return stored
          ? {
              rows: [{ revision: stored.revision, snapshot: stored.snapshot }],
              rowCount: 1,
            }
          : { rows: [], rowCount: 0 };
      }
      if (/^update/i.test(s)) {
        const expected = params?.[2];
        if (stored && stored.revision === expected) {
          stored = {
            revision: params?.[0] as string,
            snapshot: params?.[1] as CatalogSnapshot,
          };
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 1 };
    },
  };
  const store = makePgCatalogStore({ pool, table: 'skills_catalog' });
  const entry: CatalogEntry = {
    collection: { group: 'g1', description: 'd', collection: 'skills' },
    sources: ['s'],
    generation: 'g-1',
    manifest: MANIFEST,
  };
  const snap = await store.casPublish('r-init', [entry], 555);
  assert.notEqual(snap.catalogRevision, 'r-init');
  assert.equal(snap.entries.length, 1);
  const re = await store.read();
  assert.equal(re.catalogRevision, snap.catalogRevision);
  assert.equal(re.entries.length, 1);
});

test('carryForward SCROLLS the live generation by sourceId and re-ids with pointId(newGen, recordId)', async () => {
  const client = makeMockClient();
  const p = makeProvider(client);
  const store = p.forGroup('g1');
  const g0 = (await store.beginGeneration()).generation;
  await store.upsert(g0, [
    rec('a', 'g1', 's1'),
    rec('b', 'g1', 's2'),
    rec('c', 'g1', 's3'),
  ]);
  await p.publishCatalog((await p.readCatalog()).catalogRevision, [
    {
      collection: { group: 'g1', description: 'd', collection: 'skills' },
      sources: ['s1', 's2', 's3'],
      generation: g0,
      manifest: MANIFEST,
    },
  ]);
  // new generation carries forward only s1 and s2
  const g1 = (await store.beginGeneration()).generation;
  await store.carryForward(g1, ['s1', 's2']);

  // points for g1 must exist under the NEW deterministic ids
  assert.ok(client._points.has(pointId(g1, 'a')));
  assert.ok(client._points.has(pointId(g1, 'b')));
  assert.ok(!client._points.has(pointId(g1, 'c')));
  // and they carry the new generation tag
  assert.equal(client._points.get(pointId(g1, 'a'))?.payload.generation, g1);

  const hits = await store.queryRevision(g1, await embed('a'), 5);
  const ids = hits.map((h) => h.record.id).sort();
  assert.deepEqual(ids, ['a', 'b']);
});

test('durable retirement: a commit dropping G stamps retired[{G, retiredAt}] readable via catalog.read()', async () => {
  const client = makeMockClient();
  const catalogStore = makeInProcessCatalogStore();
  const p = makeProvider(client, { catalogStore, now: () => 7777 });
  const store = p.forGroup('g1');
  const g0 = (await store.beginGeneration()).generation;
  await store.upsert(g0, [rec('a')]);
  await p.publishCatalog((await p.readCatalog()).catalogRevision, [
    {
      collection: { group: 'g1', description: 'd', collection: 'skills' },
      sources: ['s'],
      generation: g0,
      manifest: MANIFEST,
    },
  ]);
  // now publish WITHOUT g0 → it is retired
  await p.publishCatalog((await p.readCatalog()).catalogRevision, []);
  const snap = await catalogStore.read();
  assert.ok(
    snap.retired?.some((r) => r.generation === g0 && r.retiredAt === 7777),
  );
  assert.equal(snap.retired?.find((r) => r.generation === g0)?.group, 'g1');
});

test('sweep + retiredGraceMs: before grace no delete; at/after grace deletes points + pruneRetired', async () => {
  const client = makeMockClient();
  const catalogStore = makeInProcessCatalogStore();
  const clock = 1000;
  const p = makeProvider(client, {
    catalogStore,
    now: () => clock,
    retiredGraceMs: 30_000,
  });
  const store = p.forGroup('g1');
  const g0 = (await store.beginGeneration()).generation;
  await store.upsert(g0, [rec('a')]);
  await p.publishCatalog((await p.readCatalog()).catalogRevision, [
    {
      collection: { group: 'g1', description: 'd', collection: 'skills' },
      sources: ['s'],
      generation: g0,
      manifest: MANIFEST,
    },
  ]);
  // retire g0 at clock=1000
  await p.publishCatalog((await p.readCatalog()).catalogRevision, []);
  assert.ok(client._points.size > 0);

  // sweep BEFORE grace → no delete, retired still present
  await p.sweep?.(1000 + 29_999);
  assert.ok(client._points.size > 0);
  assert.ok(
    (await catalogStore.read()).retired?.some((r) => r.generation === g0),
  );

  // sweep AT/after grace → delete + prune
  await p.sweep?.(1000 + 30_000);
  assert.equal(
    [...client._points.values()].filter((pt) => pt.payload.generation === g0)
      .length,
    0,
  );
  assert.ok(
    !(await catalogStore.read()).retired?.some((r) => r.generation === g0),
  );
});

test('orphan reconcile age-protected: old orphan swept, young (in-build) orphan kept', async () => {
  const client = makeMockClient();
  const catalogStore = makeInProcessCatalogStore();
  const NOW = 10_000_000;
  const p = makeProvider(client, {
    catalogStore,
    now: () => NOW,
    orphanGraceMs: 3_600_000, // 1h
  });
  // Inject an OLD orphan generation (createdAt far in the past) — neither active nor retired.
  await client.upsertPoints([
    {
      id: pointId('orphan-old', 'x'),
      vector: [1, 0, 0],
      payload: {
        generation: 'orphan-old',
        group: 'g1',
        recordId: 'x',
        content: 'cx',
        name: 'x',
        provenance: 'x',
        sourceId: 's',
        createdAt: NOW - 3_600_001, // older than grace
      },
    },
  ]);
  // Inject an IN-BUILD orphan (concurrent loader): its FIRST point is OLD (older
  // than grace) but it is still writing — its YOUNGEST point is RECENT. The sweep
  // must judge by the youngest point and KEEP it (a min-based guard would wrongly
  // delete it mid-build).
  await client.upsertPoints([
    {
      id: pointId('orphan-inbuild', 'old'),
      vector: [0, 1, 0],
      payload: {
        generation: 'orphan-inbuild',
        group: 'g1',
        recordId: 'old',
        content: 'cy',
        name: 'old',
        provenance: 'old',
        sourceId: 's',
        createdAt: NOW - 3_600_001, // FIRST batch — older than grace
      },
    },
    {
      id: pointId('orphan-inbuild', 'new'),
      vector: [0, 0, 1],
      payload: {
        generation: 'orphan-inbuild',
        group: 'g1',
        recordId: 'new',
        content: 'cz',
        name: 'new',
        provenance: 'new',
        sourceId: 's',
        createdAt: NOW - 1000, // youngest batch — within grace
      },
    },
  ]);
  await p.sweep?.(NOW);
  // old orphan (all points older than grace) swept
  assert.equal(
    [...client._points.values()].filter(
      (pt) => pt.payload.generation === 'orphan-old',
    ).length,
    0,
  );
  // in-build orphan kept — its youngest point is within grace (both points survive)
  assert.equal(
    [...client._points.values()].filter(
      (pt) => pt.payload.generation === 'orphan-inbuild',
    ).length,
    2,
  );
});

test('makeQdrantBackendProvider over IQdrantReader+ICatalogReader is read-only and serves query/activeSnapshot/readCatalog', async () => {
  const client = makeMockClient();
  const catalogStore = makeInProcessCatalogStore();
  const p = makeProvider(client, { catalogStore });
  const store = p.forGroup('g1');
  const g0 = (await store.beginGeneration()).generation;
  await store.upsert(g0, [rec('a'), rec('b')]);
  await p.publishCatalog((await p.readCatalog()).catalogRevision, [
    {
      collection: { group: 'g1', description: 'd', collection: 'skills' },
      sources: ['s'],
      generation: g0,
      manifest: MANIFEST,
    },
  ]);

  // build a READER-ONLY provider over reader interfaces (no write methods)
  const reader = { search: client.search, scroll: client.scroll };
  const catalogReader = { read: () => catalogStore.read() };
  const backendProvider = makeQdrantBackendProvider({
    reader,
    catalogReader,
    collection: 'skills',
  });

  // compile-time read-only: the reader object has no upsert/delete
  assert.equal((reader as Record<string, unknown>).upsertPoints, undefined);
  assert.equal(
    (backendProvider as unknown as Record<string, unknown>).publishCatalog,
    undefined,
  );

  const cat = await backendProvider.readCatalog();
  assert.equal(cat.entries.length, 1);
  const backend = backendProvider.forGroup('g1');
  const active = await backend.activeSnapshot();
  assert.equal(active?.revision, g0);
  const hits = await backend.queryRevision(g0, await embed('a'), 1);
  assert.equal(hits[0].record.id, 'a');
});

test('asBackendProvider() gives an in-process read view', async () => {
  const client = makeMockClient();
  const p = makeProvider(client);
  const store = p.forGroup('g1');
  const g0 = (await store.beginGeneration()).generation;
  await store.upsert(g0, [rec('a')]);
  await p.publishCatalog((await p.readCatalog()).catalogRevision, [
    {
      collection: { group: 'g1', description: 'd', collection: 'skills' },
      sources: ['s'],
      generation: g0,
      manifest: MANIFEST,
    },
  ]);
  const bp = p.asBackendProvider();
  const active = await bp.forGroup('g1').activeSnapshot();
  assert.equal(active?.revision, g0);
  assert.ok(eq((await bp.readCatalog()).entries.length, 1));
});

// P2-C — defence-in-depth: the lib rejects an unsafe table identifier before any SQL.
test('makePgCatalogStore rejects an unsafe table identifier', () => {
  const pool: IPgPool = { query: async () => ({ rows: [], rowCount: 0 }) };
  assert.throws(
    () => makePgCatalogStore({ pool, table: 'foo; DROP TABLE x' }),
    /invalid catalog table identifier/i,
  );
});

test('makePgCatalogReader rejects an unsafe table identifier', () => {
  const pool: IPgPool = { query: async () => ({ rows: [], rowCount: 0 }) };
  assert.throws(
    () => makePgCatalogReader({ pool, table: 'a"b' }),
    /invalid catalog table identifier/i,
  );
});

test('makePgCatalogStore / Reader accept a valid identifier and schema.table', () => {
  const pool: IPgPool = { query: async () => ({ rows: [], rowCount: 0 }) };
  assert.doesNotThrow(() =>
    makePgCatalogStore({ pool, table: 'skills_catalog' }),
  );
  assert.doesNotThrow(() =>
    makePgCatalogReader({ pool, table: 'public.skills_catalog' }),
  );
});

// --- read-after-write visibility at the activation boundary -----------------

test('makeQdrantClient.upsertPoints adds ?wait=true only when opts.wait set', async () => {
  const urls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    urls.push(String(input));
    return { ok: true, status: 200 } as Response;
  }) as typeof fetch;
  try {
    const client = makeQdrantClient({
      url: 'http://q',
      collection: 'skills',
    });
    const pts = [{ id: 'p1', vector: [1, 0, 0], payload: { generation: 'g' } }];
    await client.upsertPoints(pts); // default: throughput, no wait
    await client.upsertPoints(pts, { wait: true }); // activation ingest
    assert.equal(urls.length, 2);
    assert.equal(urls[0], 'http://q/collections/skills/points');
    assert.equal(urls[1], 'http://q/collections/skills/points?wait=true');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('store.upsert ingest passes wait:true (points visible before publishCatalog)', async () => {
  const client = makeMockClient();
  const p = makeProvider(client);
  const store = p.forGroup('g1');
  const g0 = (await store.beginGeneration()).generation;
  await store.upsert(g0, [rec('a'), rec('b')]);
  // the generation-build upsert MUST request wait=true so the about-to-be
  // activated generation's points are searchable before activation
  assert.deepEqual(client._upsertWaits, [true]);
});

test('store.carryForward ingest passes wait:true', async () => {
  const client = makeMockClient();
  const catalogStore = makeInProcessCatalogStore();
  const p = makeProvider(client, { catalogStore });
  const store = p.forGroup('g1');
  // publish an active generation g0 with one source so there is something live
  const g0 = (await store.beginGeneration()).generation;
  await store.upsert(g0, [rec('a', 'g1', 's')]);
  await p.publishCatalog((await p.readCatalog()).catalogRevision, [
    {
      collection: { group: 'g1', description: 'd', collection: 'skills' },
      sources: ['s'],
      generation: g0,
      manifest: MANIFEST,
    },
  ]);
  client._upsertWaits.length = 0; // reset; measure carryForward only
  const g1 = (await store.beginGeneration()).generation;
  await store.carryForward(g1, ['s']);
  assert.ok(client._upsertWaits.length > 0);
  assert.ok(client._upsertWaits.every((w) => w === true));
});
