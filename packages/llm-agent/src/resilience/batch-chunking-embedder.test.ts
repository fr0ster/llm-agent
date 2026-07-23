import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IEmbedResult } from '../interfaces/rag.js';
import { BatchChunkingEmbedder } from './batch-chunking-embedder.js';

class CountingBatchEmbedder {
  readonly sizes: number[] = [];
  constructor(private readonly short = false) {}
  async embed(): Promise<IEmbedResult> {
    return { vector: [0] };
  }
  async embedBatch(texts: string[]): Promise<IEmbedResult[]> {
    this.sizes.push(texts.length);
    const out = texts.map((t) => ({ vector: [Number(t)] }));
    return this.short ? out.slice(1) : out;
  }
}

describe('BatchChunkingEmbedder', () => {
  it('splits 356 texts at a cap of 250 and preserves order', async () => {
    const inner = new CountingBatchEmbedder();
    const texts = Array.from({ length: 356 }, (_, i) => String(i));
    const out = await new BatchChunkingEmbedder(inner, 250).embedBatch(texts);
    assert.deepEqual(inner.sizes, [250, 106]);
    assert.equal(out.length, 356);
    assert.deepEqual(out[0].vector, [0]);
    assert.deepEqual(out[250].vector, [250]);
    assert.deepEqual(out[355].vector, [355]);
  });

  it('makes a single call when the cap is not exceeded', async () => {
    const inner = new CountingBatchEmbedder();
    await new BatchChunkingEmbedder(inner, 250).embedBatch(['1', '2']);
    assert.deepEqual(inner.sizes, [2]);
  });

  it('does not call the inner embedder for empty input', async () => {
    const inner = new CountingBatchEmbedder();
    const out = await new BatchChunkingEmbedder(inner, 250).embedBatch([]);
    assert.deepEqual(out, []);
    assert.deepEqual(inner.sizes, []);
  });

  it('rejects an invalid cap at construction', () => {
    const inner = new CountingBatchEmbedder();
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      assert.throws(() => new BatchChunkingEmbedder(inner, bad), /positive/);
    }
  });

  it('throws when a chunk returns the wrong number of embeddings', async () => {
    const inner = new CountingBatchEmbedder(true);
    await assert.rejects(
      () => new BatchChunkingEmbedder(inner, 10).embedBatch(['1', '2']),
      /expected 2/,
    );
  });
});
