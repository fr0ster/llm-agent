import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IEmbedResult, LogEvent } from '@mcp-abap-adt/llm-agent';
import { getResilienceMetadata } from '@mcp-abap-adt/llm-agent';
import { resolveEmbedder } from '../rag-factories.js';

class GeminiLike {
  readonly maxBatchSize = 250;
  async embed(): Promise<IEmbedResult> {
    return { vector: [0] };
  }
  async embedBatch(texts: string[]): Promise<IEmbedResult[]> {
    return texts.map(() => ({ vector: [0] }));
  }
}

describe('resolveEmbedder resilience composition', () => {
  it('composes an injected embedder and adopts its declared cap', () => {
    const e = resolveEmbedder({}, { injectedEmbedder: new GeminiLike() });
    assert.equal(getResilienceMetadata(e)?.maxBatchSize, 250);
  });

  it('lets YAML override the provider cap', () => {
    const e = resolveEmbedder(
      { maxBatchSize: 64 },
      { injectedEmbedder: new GeminiLike() },
    );
    assert.equal(getResilienceMetadata(e)?.maxBatchSize, 64);
  });

  it('re-resolving without an explicit cap keeps the cap and stays silent', () => {
    const events: LogEvent[] = [];
    const first = resolveEmbedder({}, { injectedEmbedder: new GeminiLike() });
    const second = resolveEmbedder(
      {},
      { injectedEmbedder: first, logger: { log: (e) => events.push(e) } },
    );
    assert.equal(second, first);
    assert.equal(getResilienceMetadata(second)?.maxBatchSize, 250);
    assert.deepEqual(events, []);
  });

  it('re-resolving with a different explicit cap warns once', () => {
    const events: LogEvent[] = [];
    const first = resolveEmbedder({}, { injectedEmbedder: new GeminiLike() });
    resolveEmbedder(
      { maxBatchSize: 64 },
      { injectedEmbedder: first, logger: { log: (e) => events.push(e) } },
    );
    assert.equal(events.length, 1);
  });
});
