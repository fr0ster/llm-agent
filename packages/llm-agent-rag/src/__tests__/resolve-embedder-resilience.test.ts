import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IEmbedResult, LogEvent } from '@mcp-abap-adt/llm-agent';
import { getResilienceMetadata } from '@mcp-abap-adt/llm-agent';
import { composeEmbedder } from '../rag-factories.js';

class GeminiLike {
  readonly maxBatchSize = 250;
  async embed(): Promise<IEmbedResult> {
    return { vector: [0] };
  }
  async embedBatch(texts: string[]): Promise<IEmbedResult[]> {
    return texts.map(() => ({ vector: [0] }));
  }
}

describe('composeEmbedder resilience composition', () => {
  it('composes an injected embedder and adopts its declared cap', () => {
    const e = composeEmbedder(new GeminiLike());
    assert.equal(getResilienceMetadata(e)?.maxBatchSize, 250);
  });

  it('lets YAML override the provider cap', () => {
    const e = composeEmbedder(new GeminiLike(), { maxBatchSize: 64 });
    assert.equal(getResilienceMetadata(e)?.maxBatchSize, 64);
  });

  it('re-composing without an explicit cap keeps the cap and stays silent', () => {
    const events: LogEvent[] = [];
    const first = composeEmbedder(new GeminiLike());
    const second = composeEmbedder(first, {
      logger: { log: (e) => events.push(e) },
    });
    assert.equal(second, first);
    assert.equal(getResilienceMetadata(second)?.maxBatchSize, 250);
    assert.deepEqual(events, []);
  });

  it('re-composing with a different explicit cap warns once', () => {
    const events: LogEvent[] = [];
    const first = composeEmbedder(new GeminiLike());
    composeEmbedder(first, {
      maxBatchSize: 64,
      logger: { log: (e) => events.push(e) },
    });
    assert.equal(events.length, 1);
  });
});
