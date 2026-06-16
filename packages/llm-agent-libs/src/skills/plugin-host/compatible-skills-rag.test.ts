import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SkillsIncompatibleError } from '@mcp-abap-adt/llm-agent';
import { makeCompatibleSkillsRag } from './compatible-skills-rag.js';

const MANIFEST = {
  embeddingSpaceId: 'sp',
  dimension: 3,
  retrievalSchemaVersion: 1,
};

function stubBackend(opts: {
  snapshot: () => Promise<{
    revision: string;
    manifest: typeof MANIFEST;
  } | null>;
  hits?: unknown[];
}) {
  let queryCalls = 0;
  const released: string[] = [];
  return {
    backend: {
      activeSnapshot: opts.snapshot,
      release(rev: string) {
        released.push(rev);
      },
      async queryRevision() {
        queryCalls++;
        return (opts.hits ?? []) as never;
      },
    },
    queryCalls: () => queryCalls,
    released: () => released,
  };
}

test('lease: release(revision) is called in the finally on every non-null path', async () => {
  // compatible path
  const ok = stubBackend({
    snapshot: async () => ({ revision: 'g0', manifest: MANIFEST }),
    hits: [],
  });
  const ragOk = makeCompatibleSkillsRag({
    backend: ok.backend as never,
    embedder: { embed: async () => ({ vector: [1, 0, 0] }) } as never,
    embeddingSpaceId: 'sp',
    retrievalSchemaVersion: 1,
    dimension: 3,
  });
  await ragOk.query('q', { k: 1 });
  assert.deepEqual(ok.released(), ['g0']);
  // incompatible path (no query, still releases)
  const bad = stubBackend({
    snapshot: async () => ({
      revision: 'g1',
      manifest: { ...MANIFEST, embeddingSpaceId: 'X' },
    }),
  });
  const ragBad = makeCompatibleSkillsRag({
    backend: bad.backend as never,
    embedder: { embed: async () => ({ vector: [1, 0, 0] }) } as never,
    embeddingSpaceId: 'sp',
    retrievalSchemaVersion: 1,
    dimension: 3,
  });
  await ragBad.query('q', { k: 1 });
  assert.deepEqual(bad.released(), ['g1']);
});

test('recallTimeoutMs: a query that outlives the deadline aborts → empty (no crash)', async () => {
  const backend = {
    activeSnapshot: async () => ({ revision: 'g0', manifest: MANIFEST }),
    release() {},
    async queryRevision(
      _r: string,
      _v: number[],
      _k: number,
      options?: { signal?: AbortSignal },
    ) {
      // simulate a slow backend that respects the abort signal
      return await new Promise<never[]>((resolve, reject) => {
        const t = setTimeout(() => resolve([]), 1000);
        options?.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    },
  };
  const rag = makeCompatibleSkillsRag({
    backend: backend as never,
    embedder: { embed: async () => ({ vector: [1, 0, 0] }) } as never,
    embeddingSpaceId: 'sp',
    retrievalSchemaVersion: 1,
    dimension: 3,
    recallTimeoutMs: 20,
  });
  const hits = await rag.query('q', { k: 1 }); // resolves to [] when the 20ms deadline fires
  assert.deepEqual(hits, []);
});

test('compatible revision: embeds once, calls queryRevision', async () => {
  let embeds = 0;
  const sb = stubBackend({
    snapshot: async () => ({ revision: 'g0', manifest: MANIFEST }),
    hits: [{ record: { content: 'x' }, score: 0.9 }],
  });
  const rag = makeCompatibleSkillsRag({
    backend: sb.backend as never,
    embedder: {
      embed: async () => {
        embeds++;
        return { vector: [1, 0, 0] };
      },
    } as never,
    embeddingSpaceId: 'sp',
    retrievalSchemaVersion: 1,
    dimension: 3,
  });
  const hits = await rag.query('q', { k: 1, threshold: 0 });
  assert.equal(hits.length, 1);
  assert.equal(embeds, 1);
  assert.equal(sb.queryCalls(), 1);
});

test('incompatible revision: query() degrades to empty (ZERO embeds), but activeManifest() THROWS', async () => {
  let embeds = 0;
  const sb = stubBackend({
    snapshot: async () => ({
      revision: 'g0',
      manifest: { ...MANIFEST, embeddingSpaceId: 'OTHER' },
    }),
  });
  const rag = makeCompatibleSkillsRag({
    backend: sb.backend as never,
    embedder: {
      embed: async () => {
        embeds++;
        return { vector: [1, 0, 0] };
      },
    } as never,
    embeddingSpaceId: 'sp',
    retrievalSchemaVersion: 1,
    dimension: 3,
  });
  // RUNTIME query() degrades to []
  const hits = await rag.query('q', { k: 1 });
  assert.equal(hits.length, 0);
  assert.equal(embeds, 0); // embed skipped on incompatible
  // EAGER activeManifest() THROWS (so recall-only load()/healthCheck can fail-fast)
  await assert.rejects(
    () => rag.activeManifest(),
    (e) => e instanceof SkillsIncompatibleError,
  );
});

test('null snapshot: ZERO embeds, empty', async () => {
  let embeds = 0;
  const sb = stubBackend({ snapshot: async () => null });
  const rag = makeCompatibleSkillsRag({
    backend: sb.backend as never,
    embedder: {
      embed: async () => {
        embeds++;
        return { vector: [1, 0, 0] };
      },
    } as never,
    embeddingSpaceId: 'sp',
    retrievalSchemaVersion: 1,
    dimension: 3,
  });
  assert.equal((await rag.query('q', { k: 1 })).length, 0);
  assert.equal(embeds, 0);
});

test('lazy dimension probe: no embed at construction; first activeManifest probes once', async () => {
  let embeds = 0;
  const sb = stubBackend({
    snapshot: async () => ({ revision: 'g0', manifest: MANIFEST }),
  });
  const rag = makeCompatibleSkillsRag({
    backend: sb.backend as never,
    embedder: {
      embed: async () => {
        embeds++;
        return { vector: [1, 0, 0] };
      },
    } as never,
    embeddingSpaceId: 'sp',
    retrievalSchemaVersion: 1, // dimension undeclared
  });
  assert.equal(embeds, 0); // construction did not embed
  await rag.activeManifest();
  assert.equal(embeds, 1); // one probe
});
