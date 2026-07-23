import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IEmbedResult } from '../interfaces/rag.js';
import { isBatchEmbedder } from '../interfaces/rag.js';
import type { LogEvent } from '../logger/types.js';
import {
  composeResilientEmbedder,
  getResilienceMetadata,
} from './embedder-resilience.js';

class BatchProvider {
  readonly sizes: number[] = [];
  readonly maxBatchSize?: number;
  constructor(cap?: number) {
    if (cap !== undefined) this.maxBatchSize = cap;
  }
  async embed(): Promise<IEmbedResult> {
    return { vector: [0] };
  }
  async embedBatch(texts: string[]): Promise<IEmbedResult[]> {
    this.sizes.push(texts.length);
    return texts.map(() => ({ vector: [0] }));
  }
}

class EmbedOnly {
  async embed(): Promise<IEmbedResult> {
    return { vector: [0] };
  }
}

function collectingLogger(events: LogEvent[]) {
  return { log: (e: LogEvent) => events.push(e) };
}

describe('composeResilientEmbedder', () => {
  it('chunks at the provider-declared cap', async () => {
    const provider = new BatchProvider(250);
    const composed = composeResilientEmbedder(provider);
    await (
      composed as { embedBatch(t: string[]): Promise<IEmbedResult[]> }
    ).embedBatch(Array.from({ length: 356 }, (_, i) => String(i)));
    assert.deepEqual(provider.sizes, [250, 106]);
    assert.equal(getResilienceMetadata(composed)?.maxBatchSize, 250);
  });

  it('prefers an explicit cap over the provider cap', () => {
    const composed = composeResilientEmbedder(new BatchProvider(250), {
      explicitMaxBatchSize: 50,
    });
    assert.equal(getResilienceMetadata(composed)?.maxBatchSize, 50);
  });

  it('falls back to the default when nothing declares a cap', () => {
    const composed = composeResilientEmbedder(new BatchProvider());
    assert.equal(getResilienceMetadata(composed)?.maxBatchSize, 100);
  });

  it('preserves non-batch capability', () => {
    const composed = composeResilientEmbedder(new EmbedOnly());
    assert.equal(isBatchEmbedder(composed), false);
    assert.equal(getResilienceMetadata(composed)?.maxBatchSize, undefined);
  });

  it('is idempotent and does not warn without an explicit cap', () => {
    const events: LogEvent[] = [];
    const once = composeResilientEmbedder(new BatchProvider(250));
    const twice = composeResilientEmbedder(once, {
      logger: collectingLogger(events),
    });
    assert.equal(twice, once);
    assert.deepEqual(events, []);
  });

  it('warns and keeps the owned cap when an explicit cap differs', () => {
    const events: LogEvent[] = [];
    const once = composeResilientEmbedder(new BatchProvider(250));
    const twice = composeResilientEmbedder(once, {
      explicitMaxBatchSize: 50,
      logger: collectingLogger(events),
    });
    assert.equal(twice, once);
    assert.equal(events.length, 1);
    assert.match(String((events[0] as { message: string }).message), /250.*50/);
  });

  it('is silent when the explicit cap equals the owned one', () => {
    const events: LogEvent[] = [];
    const once = composeResilientEmbedder(new BatchProvider(250));
    composeResilientEmbedder(once, {
      explicitMaxBatchSize: 250,
      logger: collectingLogger(events),
    });
    assert.deepEqual(events, []);
  });

  it('ignores a look-alike plain property', () => {
    const impostor = {
      embed: async () => ({ vector: [0] }),
      resilience: {},
    };
    assert.equal(getResilienceMetadata(impostor), undefined);
  });
});
