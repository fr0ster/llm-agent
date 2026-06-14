import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CatalogCasError } from '@mcp-abap-adt/llm-agent';
import {
  makePgCatalogReader,
  makePgCatalogStore,
  makeQdrantClient,
  makeQdrantReader,
  makeQdrantStoreProvider,
  makeSkillPluginHost,
} from '@mcp-abap-adt/llm-agent-libs';
import {
  makePgPool,
  makePgReadPool,
} from '@mcp-abap-adt/llm-agent-server-libs';
import { OllamaEmbedder } from '@mcp-abap-adt/ollama-embedder';
import {
  makeRevisionedSource,
  SOURCE_ID,
  V1_POINTS,
  V2_POINTS,
} from './fixtures/revisioned-source.js';
import { assertHoldsFor, pollUntil, withPools } from './helpers.js';

const PG_URL = process.env.PG_TEST_URL!;
const PG_READ_URL = process.env.PG_READ_TEST_URL!;
const QDRANT_URL = process.env.QDRANT_TEST_URL!;
const COLLECTION = process.env.QDRANT_TEST_COLLECTION!;
const EMBED_DIM = Number(process.env.EMBED_DIM ?? '768');
const OLLAMA_URL = process.env.OLLAMA_TEST_URL!;
const MODEL = process.env.OLLAMA_TEST_MODEL ?? 'nomic-embed-text';
const TABLE = 'skills_catalog';

const RETIRED_GRACE_MS = 10_000;
const ORPHAN_GRACE_MS = 60_000;

// EXACT, generation-scoped count via /points/count. Active AND retired generations
// share the collection after a reload, so a collection-level count is wrong.
async function countGeneration(generation: string): Promise<number> {
  const res = await fetch(
    `${QDRANT_URL}/collections/${COLLECTION}/points/count`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        filter: { must: [{ key: 'generation', match: { value: generation } }] },
        exact: true,
      }),
    },
  );
  if (!res.ok) throw new Error(`qdrant points/count failed: ${res.status}`);
  const json = (await res.json()) as { result?: { count?: number } };
  return json.result?.count ?? 0;
}

// Active generation for a group from the committed catalog snapshot.
async function activeGeneration(
  catalogStore: {
    read(): Promise<{
      entries: { collection: { group: string }; generation: string }[];
    }>;
  },
  group: string,
): Promise<string> {
  const snap = await catalogStore.read();
  const entry = snap.entries.find((e) => e.collection.group === group);
  assert.ok(entry, `no committed entry for group '${group}'`);
  return entry.generation;
}

test('skill-host PG+Qdrant durable persistence (ordered scenario)', async (t) => {
  await withPools(async (register) => {
    // Shared state for the whole scenario. Injected clock so Case 4's sweep
    // grace windows are deterministic.
    let clock = 1_000_000;
    const now = () => clock;
    const source = makeRevisionedSource();
    source.setRevision('v1');

    const pgPool = register(makePgPool(PG_URL, TABLE)) as ReturnType<
      typeof makePgPool
    >;
    const catalogStore = makePgCatalogStore({ pool: pgPool, table: TABLE });
    const client = makeQdrantClient({
      url: QDRANT_URL,
      collection: COLLECTION,
    });
    const embedder = new OllamaEmbedder({
      ollamaUrl: OLLAMA_URL,
      model: MODEL,
    });
    const storeProvider = makeQdrantStoreProvider({
      client,
      collection: COLLECTION,
      catalogStore,
      embed: async (tx, o) => (await embedder.embed(tx, o)).vector,
      retiredGraceMs: RETIRED_GRACE_MS,
      orphanGraceMs: ORPHAN_GRACE_MS,
      now,
    });
    const host = makeSkillPluginHost({
      sources: [{ id: SOURCE_ID, source }],
      storeProvider,
      embedder,
      embeddingSpaceId: 'itest-ollama-nomic-embed-text',
      retrievalSchemaVersion: 1,
      dimension: EMBED_DIM,
      now,
    });

    // Per-group v1 generations captured in Case 1, consumed by Case 4.
    let g1a = '';
    let g1b = '';

    await t.test(
      'embedder returns a 768-dim vector (model present)',
      async () => {
        const v = (await embedder.embed('hello')).vector;
        assert.equal(v.length, EMBED_DIM);
      },
    );

    await t.test(
      'Case 1: ingest + commit (v1) → PG row + Qdrant vectors',
      async () => {
        const result = await host.load();
        assert.equal(result.ok, true, `load not ok: ${JSON.stringify(result)}`);
        assert.deepEqual([...result.committed].sort(), ['alpha', 'beta']);

        const snap = await catalogStore.read();
        assert.ok(
          snap.catalogRevision && snap.catalogRevision !== 'c0',
          'revision advanced',
        );
        assert.equal(snap.entries.length, 2);

        g1a = await activeGeneration(catalogStore, 'alpha');
        g1b = await activeGeneration(catalogStore, 'beta');
        await pollUntil(
          async () =>
            (await countGeneration(g1a)) + (await countGeneration(g1b)),
          {
            predicate: (n) => n === V1_POINTS,
            label: `v1 committed points == ${V1_POINTS}`,
          },
        );
      },
    );

    await t.test(
      'Case 2: recall returns ranked hits from the queried collection',
      async () => {
        const hits = await host
          .rag('alpha')
          .query('reading a file from disk', { k: 3 });
        assert.ok(hits.length > 0, 'expected at least one hit');
        for (const h of hits) assert.equal(h.record.group, 'alpha'); // only alpha
        for (let i = 1; i < hits.length; i++) {
          assert.ok(
            hits[i - 1].score >= hits[i].score,
            'scores not descending',
          );
        }
        // the file-reading skill should rank at/near the top for this query
        assert.match(hits[0].record.name, /open-file/);
      },
    );

    await t.test(
      'Case 3: fenced catalog CAS rejects a stale revision',
      async () => {
        const r0 = await catalogStore.read();
        const R0 = r0.catalogRevision;

        // Benign republish: same entries, bumps the revision to R1, no generation churn.
        const r1 = await catalogStore.casPublish(R0, r0.entries, now());
        const R1 = r1.catalogRevision;
        assert.notEqual(R1, R0, 'benign republish advanced the revision');

        // A second publish against the now-stale R0 must be rejected.
        await assert.rejects(
          () => catalogStore.casPublish(R0, r0.entries, now()),
          (err) => err instanceof CatalogCasError,
          'expected CatalogCasError on stale revision',
        );

        // The committed revision is R1, unchanged by the rejected attempt.
        const after = await catalogStore.read();
        assert.equal(after.catalogRevision, R1);
      },
    );

    await t.test(
      'Case 4: reload retires BOTH prior generations; sweeper is age-protected',
      async () => {
        // Reload v2 → NEW generation for BOTH groups; BOTH prior generations retired.
        source.setRevision('v2');
        await host.load();
        const g2a = await activeGeneration(catalogStore, 'alpha');
        const g2b = await activeGeneration(catalogStore, 'beta');
        assert.notEqual(g2a, g1a, 'alpha generation must change on reload');
        assert.notEqual(g2b, g1b, 'beta generation must change on reload');

        // v2 active points visible across the two NEW generations.
        await pollUntil(
          async () =>
            (await countGeneration(g2a)) + (await countGeneration(g2b)),
          {
            predicate: (n) => n === V2_POINTS,
            label: `v2 committed points == ${V2_POINTS}`,
          },
        );

        // Durable retired[] holds BOTH prior generations.
        const snap = await catalogStore.read();
        const retired = new Set((snap.retired ?? []).map((r) => r.generation));
        assert.ok(retired.has(g1a), 'v1 alpha generation retired');
        assert.ok(retired.has(g1b), 'v1 beta generation retired');

        // AGE PROTECTION (sustained): sweep BEFORE grace must delete NOTHING. The
        // combined retired count must stay at its full value (V1_POINTS) over a
        // window — a one-shot "> 0" would pass instantly (delete not yet propagated).
        await storeProvider.sweep(clock); // tick == now, retiredAt + grace > now
        await assertHoldsFor(
          async () =>
            (await countGeneration(g1a)) + (await countGeneration(g1b)),
          {
            predicate: (n) => n === V1_POINTS,
            windowMs: 1500,
            label: 'retired count stays full pre-grace',
          },
        );

        // POST-GRACE: advance past the grace, sweep → BOTH retired generations reclaimed.
        clock += RETIRED_GRACE_MS + 1;
        await storeProvider.sweep(clock);
        await pollUntil(
          async () =>
            (await countGeneration(g1a)) + (await countGeneration(g1b)),
          {
            predicate: (n) => n === 0,
            label: 'both retired generations reclaimed to 0',
          },
        );
      },
    );

    await t.test(
      'Case 5: recall-only read path under SELECT-only credentials',
      async () => {
        const expected = await catalogStore.read(); // v2 committed state from Case 4

        // (a) READ path over the SELECT-only role reads the same committed catalog.
        const readPool = register(makePgReadPool(PG_READ_URL)) as ReturnType<
          typeof makePgReadPool
        >;
        const reader = makePgCatalogReader({ pool: readPool, table: TABLE });
        const seen = await reader.read();
        assert.equal(seen.catalogRevision, expected.catalogRevision);
        assert.equal(seen.entries.length, expected.entries.length);

        // Qdrant reader returns vectors for the active alpha generation.
        const qreader = makeQdrantReader({
          url: QDRANT_URL,
          collection: COLLECTION,
        });
        const genAlpha = expected.entries.find(
          (e) => e.collection.group === 'alpha',
        )!.generation;
        const page = await qreader.scroll({ generation: genAlpha });
        assert.ok(
          page.points.length > 0,
          'read-only Qdrant reader sees committed points',
        );

        // (b) The read-only login must REJECT write AND DDL. Run UNAMBIGUOUSLY
        // forbidden statements directly through the restricted pool — NOT
        // `CREATE TABLE IF NOT EXISTS skills_catalog`, which Postgres may short-circuit
        // on the already-existing table. makePgReadPool.query runs raw SQL (no DDL
        // wrapper), so it is the clean vehicle for the negative probes.
        //   INSERT into the existing catalog table → denied (no INSERT grant).
        await assert.rejects(
          () =>
            readPool.query(
              `INSERT INTO ${TABLE} (id, revision, snapshot) VALUES ('x','x','{}')`,
            ),
          /permission denied/i,
          'read-only role must be denied INSERT',
        );
        //   CREATE a brand-new table (never short-circuited) → denied (no CREATE grant).
        await assert.rejects(
          () => readPool.query('CREATE TABLE readonly_probe (i int)'),
          /permission denied/i,
          'read-only role must be denied CREATE TABLE',
        );
      },
    );
  });
});
