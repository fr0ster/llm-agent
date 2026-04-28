import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OverlayRag } from '../overlays/overlay-rag.js';
import { SessionScopedRag } from '../overlays/session-scoped-rag.js';
import { TextOnlyEmbedding } from '../query-embedding.js';

function stub(results, records = {}) {
  return {
    query: async () => ({ ok: true, value: results }),
    getById: async (id) => ({ ok: true, value: records[id] ?? null }),
    healthCheck: async () => ({ ok: true, value: undefined }),
  };
}
describe('OverlayRag.query', () => {
  it('overlay wins on canonicalKey collision regardless of score', async () => {
    const base = stub([
      { text: 'old', metadata: { id: 'b1', canonicalKey: 'k' }, score: 0.99 },
      { text: 'other', metadata: { id: 'b2', canonicalKey: 'x' }, score: 0.5 },
    ]);
    const overlay = stub([
      { text: 'new', metadata: { id: 'o1', canonicalKey: 'k' }, score: 0.1 },
    ]);
    const rag = new OverlayRag(base, overlay);
    const res = await rag.query(new TextOnlyEmbedding('q'), 10);
    assert.ok(res.ok);
    const texts = res.value.map((r) => r.text).sort();
    assert.deepEqual(texts, ['new', 'other']);
  });
  it('passes base records through when overlay has no canonicalKey match', async () => {
    const base = stub([
      { text: 'b', metadata: { id: 'b', canonicalKey: 'k' }, score: 1 },
    ]);
    const overlay = stub([]);
    const rag = new OverlayRag(base, overlay);
    const res = await rag.query(new TextOnlyEmbedding('q'), 10);
    assert.ok(res.ok);
    assert.deepEqual(
      res.value.map((r) => r.text),
      ['b'],
    );
  });
  it('respects k limit after merge', async () => {
    const base = stub([
      { text: 'b1', metadata: { id: 'b1', canonicalKey: 'x1' }, score: 0.5 },
      { text: 'b2', metadata: { id: 'b2', canonicalKey: 'x2' }, score: 0.4 },
    ]);
    const overlay = stub([
      { text: 'o1', metadata: { id: 'o1', canonicalKey: 'y1' }, score: 0.9 },
      { text: 'o2', metadata: { id: 'o2', canonicalKey: 'y2' }, score: 0.8 },
    ]);
    const rag = new OverlayRag(base, overlay);
    const res = await rag.query(new TextOnlyEmbedding('q'), 2);
    assert.ok(res.ok);
    assert.equal(res.value.length, 2);
    assert.deepEqual(
      res.value.map((r) => r.text),
      ['o1', 'o2'],
    );
  });
});
describe('OverlayRag.getById', () => {
  it('prefers overlay, falls back to base, null when both miss', async () => {
    const base = stub([], {
      b1: { text: 'base', metadata: { id: 'b1' }, score: 1 },
    });
    const overlay = stub([], {
      o1: { text: 'ovr', metadata: { id: 'o1' }, score: 1 },
    });
    const rag = new OverlayRag(base, overlay);
    const fromOverlay = await rag.getById?.('o1');
    assert.ok(fromOverlay?.ok && fromOverlay.value?.text === 'ovr');
    const fromBase = await rag.getById?.('b1');
    assert.ok(fromBase?.ok && fromBase.value?.text === 'base');
    const miss = await rag.getById?.('nope');
    assert.ok(miss?.ok && miss.value === null);
  });
});
describe('OverlayRag.healthCheck', () => {
  it('requires both healthy', async () => {
    const base = stub([]);
    const overlay = {
      query: async () => ({ ok: true, value: [] }),
      getById: async () => ({ ok: true, value: null }),
      healthCheck: async () => ({
        ok: false,
        error: { code: 'FAIL', message: 'x' },
      }),
    };
    const rag = new OverlayRag(base, overlay);
    const res = await rag.healthCheck();
    assert.ok(!res.ok);
  });
});
describe('SessionScopedRag', () => {
  it('includes only overlay records matching sessionId', async () => {
    const base = stub([
      { text: 'b', metadata: { id: 'b', canonicalKey: 'b' }, score: 1 },
    ]);
    const overlay = stub([
      {
        text: 'own',
        metadata: { id: 'o1', canonicalKey: 'x', sessionId: 'S' },
        score: 1,
      },
      {
        text: 'other',
        metadata: { id: 'o2', canonicalKey: 'y', sessionId: 'X' },
        score: 1,
      },
    ]);
    const rag = new SessionScopedRag(base, overlay, 'S');
    const res = await rag.query(new TextOnlyEmbedding('q'), 10);
    assert.ok(res.ok);
    const texts = res.value.map((r) => r.text).sort();
    assert.deepEqual(texts, ['b', 'own']);
  });
  it('excludes overlay records older than ttlMs', async () => {
    const base = stub([]);
    const now = Date.now();
    const overlay = stub([
      {
        text: 'fresh',
        metadata: {
          id: 'f',
          canonicalKey: 'f',
          sessionId: 'S',
          createdAt: now,
        },
        score: 1,
      },
      {
        text: 'stale',
        metadata: {
          id: 's',
          canonicalKey: 's',
          sessionId: 'S',
          createdAt: now - 60_000,
        },
        score: 1,
      },
    ]);
    const rag = new SessionScopedRag(base, overlay, 'S', 10_000);
    const res = await rag.query(new TextOnlyEmbedding('q'), 10);
    assert.ok(res.ok);
    assert.deepEqual(
      res.value.map((r) => r.text),
      ['fresh'],
    );
  });
  it('getById rejects overlay record with wrong sessionId', async () => {
    const base = stub([], {
      x: { text: 'base', metadata: { id: 'x' }, score: 1 },
    });
    const overlay = stub([], {
      x: {
        text: 'ovr',
        metadata: { id: 'x', sessionId: 'WRONG' },
        score: 1,
      },
    });
    const rag = new SessionScopedRag(base, overlay, 'RIGHT');
    const res = await rag.getById?.('x');
    assert.ok(res?.ok && res.value?.text === 'base');
  });
});
//# sourceMappingURL=overlay-rag.test.js.map
