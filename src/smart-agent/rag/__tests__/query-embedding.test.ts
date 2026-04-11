import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IEmbedder, IEmbedResult } from '../../interfaces/rag.js';
import {
  FallbackQueryEmbedding,
  QueryEmbedding,
  TextOnlyEmbedding,
} from '../query-embedding.js';

// ---------------------------------------------------------------------------
// Stub embedder factory
// ---------------------------------------------------------------------------

function makeStubEmbedder(
  usage?: IEmbedResult['usage'],
): IEmbedder & { callCount: number } {
  let callCount = 0;
  return {
    get callCount() {
      return callCount;
    },
    async embed(_text: string) {
      callCount++;
      return { vector: [1, 2, 3], usage };
    },
  };
}

// ---------------------------------------------------------------------------
// QueryEmbedding
// ---------------------------------------------------------------------------

describe('QueryEmbedding', () => {
  it('toVector() returns the vector from embed result', async () => {
    const embedder = makeStubEmbedder();
    const qe = new QueryEmbedding('hello', embedder);
    const vector = await qe.toVector();
    assert.deepEqual(vector, [1, 2, 3]);
  });

  it('getUsage() returns usage when embedder provides it', async () => {
    const usage = { promptTokens: 10, totalTokens: 10 };
    const embedder = makeStubEmbedder(usage);
    const qe = new QueryEmbedding('hello', embedder);
    const result = await qe.getUsage();
    assert.deepEqual(result, usage);
  });

  it('getUsage() returns undefined when embedder provides no usage', async () => {
    const embedder = makeStubEmbedder(undefined);
    const qe = new QueryEmbedding('hello', embedder);
    const result = await qe.getUsage();
    assert.equal(result, undefined);
  });

  it('embed is called only once even if both toVector() and getUsage() are called', async () => {
    const embedder = makeStubEmbedder({ promptTokens: 5, totalTokens: 5 });
    const qe = new QueryEmbedding('hello', embedder);

    // Call both — should share one underlying embed() call
    await qe.toVector();
    await qe.getUsage();
    await qe.toVector();

    assert.equal(embedder.callCount, 1);
  });

  it('memoization works for concurrent calls', async () => {
    const embedder = makeStubEmbedder();
    const qe = new QueryEmbedding('hello', embedder);

    // Fire multiple concurrent calls
    await Promise.all([qe.toVector(), qe.toVector(), qe.getUsage()]);

    assert.equal(embedder.callCount, 1);
  });
});

// ---------------------------------------------------------------------------
// TextOnlyEmbedding
// ---------------------------------------------------------------------------

describe('TextOnlyEmbedding', () => {
  it('exposes text property', () => {
    const te = new TextOnlyEmbedding('query text');
    assert.equal(te.text, 'query text');
  });

  it('toVector() rejects with RagError', async () => {
    const te = new TextOnlyEmbedding('query');
    await assert.rejects(
      () => te.toVector(),
      (err: Error) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /embedder/i);
        return true;
      },
    );
  });

  it('has no getUsage method', () => {
    const te = new TextOnlyEmbedding('query');
    assert.equal(typeof (te as { getUsage?: unknown }).getUsage, 'undefined');
  });
});

// ---------------------------------------------------------------------------
// FallbackQueryEmbedding
// ---------------------------------------------------------------------------

describe('FallbackQueryEmbedding', () => {
  it('toVector() returns inner result when inner succeeds', async () => {
    const inner = new QueryEmbedding('hello', makeStubEmbedder());
    const fallback = makeStubEmbedder();
    const fqe = new FallbackQueryEmbedding(inner, fallback);
    const vector = await fqe.toVector();
    assert.deepEqual(vector, [1, 2, 3]);
    assert.equal(fallback.callCount, 0);
  });

  it('toVector() falls back to fallback embedder when inner fails', async () => {
    const inner = new TextOnlyEmbedding('hello'); // always rejects on toVector
    const fallbackEmbedder = makeStubEmbedder();
    const fqe = new FallbackQueryEmbedding(inner, fallbackEmbedder);
    const vector = await fqe.toVector();
    assert.deepEqual(vector, [1, 2, 3]);
    assert.equal(fallbackEmbedder.callCount, 1);
  });

  it('text property reflects inner text', () => {
    const inner = new TextOnlyEmbedding('my query');
    const fqe = new FallbackQueryEmbedding(inner, makeStubEmbedder());
    assert.equal(fqe.text, 'my query');
  });

  it('fallback result is memoized', async () => {
    const inner = new TextOnlyEmbedding('hello');
    const fallbackEmbedder = makeStubEmbedder();
    const fqe = new FallbackQueryEmbedding(inner, fallbackEmbedder);

    await fqe.toVector();
    await fqe.toVector();

    assert.equal(fallbackEmbedder.callCount, 1);
  });
});
