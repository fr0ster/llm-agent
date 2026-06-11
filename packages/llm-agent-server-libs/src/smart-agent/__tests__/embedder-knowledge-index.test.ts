import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { makeKnowledgeSemanticIndex } from '../embedder-knowledge-index.js';
import { JsonlKnowledgeBackend } from '../jsonl-knowledge-backend.js';

// Stub embedder: known words → orthogonal unit vectors; unknown → zero.
const VOCAB: Record<string, number[]> = {
  alpha: [1, 0, 0],
  beta: [0, 1, 0],
  gamma: [0, 0, 1],
};
const stub = {
  embed: async (t: string) => ({ vector: VOCAB[t.trim().toLowerCase()] ?? [0, 0, 0] }),
} as never;
const meta = (over: object) => ({
  traceId: 't',
  turnId: 't',
  stepperId: 'controller',
  task: 'x',
  artifactType: 'step-result',
  createdAt: '2026-06-10T00:00:00.000Z',
  ...over,
});

describe('makeKnowledgeSemanticIndex', () => {
  it('ranks by cosine similarity, not insertion order', async () => {
    const idx = makeKnowledgeSemanticIndex(stub);
    await idx.upsert('s', { content: 'gamma', metadata: meta({ runId: 'R' }) });
    await idx.upsert('s', { content: 'alpha', metadata: meta({ runId: 'R' }) });
    const hits = await idx.query('s', 'alpha', 1);
    assert.equal(hits[0].content, 'alpha', 'most similar wins regardless of insertion order');
  });
  it('applies the runId filter PRE-cap (foreign-run hits never crowd the cap)', async () => {
    const idx = makeKnowledgeSemanticIndex(stub);
    await idx.upsert('s', { content: 'alpha', metadata: meta({ runId: 'OTHER' }) });
    await idx.upsert('s', { content: 'alpha', metadata: meta({ runId: 'OTHER' }) });
    await idx.upsert('s', { content: 'alpha', metadata: meta({ runId: 'TARGET' }) });
    const hits = await idx.query('s', 'alpha', 1, { runId: 'TARGET' });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].metadata.runId, 'TARGET', 'filter applied before the k=1 cap');
  });
  it('deleteSession drops the indexed vectors (no stale hits on session-id reuse)', async () => {
    const idx = makeKnowledgeSemanticIndex(stub);
    await idx.upsert('s', { content: 'alpha', metadata: meta({ runId: 'R' }) });
    idx.deleteSession('s');
    assert.equal((await idx.query('s', 'alpha', 5)).length, 0, 'deleted session returns nothing');
  });
});

describe('JsonlKnowledgeBackend index lifecycle', () => {
  const withDir = async (fn: (dir: string) => Promise<void>) => {
    const dir = await mkdtemp(join(tmpdir(), 'ctrl-idx-'));
    try {
      await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  it('rehydrates the index from the durable JSONL after a restart', async () => {
    await withDir(async (dir) => {
      const b1 = new JsonlKnowledgeBackend(dir, makeKnowledgeSemanticIndex(stub));
      await b1.put('s', { content: 'alpha', metadata: meta({ runId: 'R' }) });
      // Restart: a NEW backend + NEW empty index over the same logDir.
      const b2 = new JsonlKnowledgeBackend(dir, makeKnowledgeSemanticIndex(stub));
      const hits = await b2.semanticQuery('s', 'alpha', 5, { runId: 'R' });
      assert.equal(hits.length, 1, 'index lazily rehydrated from the durable JSONL');
      assert.equal(hits[0].content, 'alpha');
    });
  });

  it('write-before-first-query does NOT duplicate the entry in the index', async () => {
    await withDir(async (dir) => {
      const b = new JsonlKnowledgeBackend(dir, makeKnowledgeSemanticIndex(stub));
      await b.put('s', { content: 'alpha', metadata: meta({ runId: 'R' }) });
      const hits = await b.semanticQuery('s', 'alpha', 10, { runId: 'R' });
      assert.equal(hits.length, 1, 'entry indexed exactly once');
    });
  });

  it('concurrent first queries rehydrate exactly once (single-flight)', async () => {
    await withDir(async (dir) => {
      const seed = new JsonlKnowledgeBackend(dir, makeKnowledgeSemanticIndex(stub));
      await seed.put('s', { content: 'alpha', metadata: meta({ runId: 'R' }) });
      const b = new JsonlKnowledgeBackend(dir, makeKnowledgeSemanticIndex(stub));
      const [a, c] = await Promise.all([
        b.semanticQuery('s', 'alpha', 10, { runId: 'R' }),
        b.semanticQuery('s', 'alpha', 10, { runId: 'R' }),
      ]);
      assert.equal(a.length, 1, 'no double-index from concurrent rehydration');
      assert.equal(c.length, 1);
    });
  });

  it('upsert failure does NOT fail the put and does NOT duplicate the JSONL entry', async () => {
    await withDir(async (dir) => {
      const failing = {
        async upsert() {
          throw new Error('index down');
        },
        async query() {
          return [];
        },
        deleteSession() {},
      };
      const b = new JsonlKnowledgeBackend(dir, failing as never);
      await b.put('s', { content: 'alpha', metadata: meta({ runId: 'R' }) }); // must NOT throw
      const entries = await b.scan('s');
      assert.equal(entries.length, 1, 'durable JSONL has the entry exactly once');
    });
  });
});
