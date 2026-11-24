import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IEmbedResult, LogEvent } from '@mcp-abap-adt/llm-agent';
import {
  DefaultWaitStrategy,
  getResilienceMetadata,
  staticApiKey,
} from '@mcp-abap-adt/llm-agent';
import { prefetchEmbedderFactories } from '../embedder-factories.js';
import { composeEmbedder, resolveEmbedder } from '../rag-factories.js';

for (const provider of ['openai', 'ollama'] as const) {
  it(`resolved ${provider} retains retries through composition`, async (t) => {
    await prefetchEmbedderFactories([provider]);
    const waits: number[] = [];
    t.mock.method(DefaultWaitStrategy.prototype, 'wait', async (ms: number) => {
      waits.push(ms);
      return 'elapsed';
    });
    let requests = 0;
    t.mock.method(globalThis, 'fetch', async (url: URL | Request | string) => {
      if (String(url).endsWith('/api/show')) return Response.json({});
      if (++requests === 1) return new Response('unavailable', { status: 503 });
      return Response.json(
        provider === 'openai'
          ? { data: [{ embedding: [1] }] }
          : { embeddings: [[1]] },
      );
    });
    const cfg = { model: 'test' };
    const embedder = resolveEmbedder(
      provider === 'openai'
        ? { ...cfg, provider, credential: staticApiKey('test') }
        : { ...cfg, provider },
    );
    assert.deepEqual((await embedder.embed('q')).vector, [1]);
    assert.equal(requests, 2);
    assert.deepEqual(waits, [2000]);
    assert.equal(getResilienceMetadata(embedder)?.maxBatchSize, 100);
  });
}

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

it('forwards disabled retries and throttle policy while keeping input cap', async () => {
  const { WaitAsTold } = await import('@mcp-abap-adt/llm-agent');
  let calls = 0;
  const composed = composeEmbedder(
    {
      async embed(text: string) {
        assert.equal(text, 'abc');
        if (++calls <= 10)
          throw Object.assign(new Error('quota'), {
            status: 429,
            retryAfterSeconds: 0,
          });
        return { vector: [1] };
      },
    },
    {
      retry: false,
      throttle: {
        key: 'compose-rag-throttle',
        strategy: new WaitAsTold({ fallbackBackoffMs: 2000 }),
      },
      maxInputChars: 3,
    },
  );
  assert.deepEqual(await composed.embed('abcdef'), { vector: [1] });
  assert.equal(calls, 11);
});
