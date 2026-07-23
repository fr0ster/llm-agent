import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IEmbedResult } from '@mcp-abap-adt/llm-agent';
import {
  composeResilientEmbedder,
  getResilienceMetadata,
} from '@mcp-abap-adt/llm-agent';
import { wrapEmbedder } from '../usage-logging-embedder.js';

class BatchProvider {
  readonly maxBatchSize = 250;
  async embed(): Promise<IEmbedResult> {
    return { vector: [0] };
  }
  async embedBatch(texts: string[]): Promise<IEmbedResult[]> {
    return texts.map(() => ({ vector: [0] }));
  }
}

describe('wrapEmbedder resilience metadata', () => {
  it('propagates the inner metadata to the wrapper', () => {
    const composed = composeResilientEmbedder(new BatchProvider());
    const wrapped = wrapEmbedder(composed);
    // A new instance, yet the brand survives — `inner` is protected, so a
    // caller holding the wrapper could not otherwise see it.
    assert.notEqual(wrapped, composed);
    assert.equal(getResilienceMetadata(wrapped)?.maxBatchSize, 250);
  });

  it('adds no metadata when the inner has none', () => {
    assert.equal(
      getResilienceMetadata(wrapEmbedder(new BatchProvider())),
      undefined,
    );
  });
});
