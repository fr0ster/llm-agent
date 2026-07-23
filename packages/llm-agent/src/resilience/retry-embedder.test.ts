import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IEmbedResult } from '../interfaces/rag.js';
import { isBatchEmbedder } from '../interfaces/rag.js';
import type { CallOptions } from '../interfaces/types.js';
import { RagError } from '../interfaces/types.js';
import { extractStatusCode, withRetry } from './retry-embedder.js';

const FAST = { backoffMs: 1 };

class ScriptedEmbedder {
  calls = 0;
  constructor(private readonly script: Array<'ok' | unknown>) {}
  async embed(_text: string, _o?: CallOptions): Promise<IEmbedResult> {
    const step = this.script[Math.min(this.calls, this.script.length - 1)];
    this.calls++;
    if (step === 'ok') return { vector: [1] };
    throw step;
  }
  async embedBatch(texts: string[], o?: CallOptions): Promise<IEmbedResult[]> {
    await this.embed(texts[0] ?? '', o);
    return texts.map(() => ({ vector: [1] }));
  }
}

class EmbedOnly {
  async embed(): Promise<IEmbedResult> {
    return { vector: [1] };
  }
}

describe('extractStatusCode', () => {
  it('reads status, statusCode and cause', () => {
    assert.equal(extractStatusCode({ status: 429 }), 429);
    assert.equal(extractStatusCode({ statusCode: 503 }), 503);
    assert.equal(extractStatusCode({ cause: { status: 500 } }), 500);
  });

  it('terminates on a cyclic cause chain', () => {
    const a: { cause?: unknown } = {};
    a.cause = a;
    assert.equal(extractStatusCode(a), undefined);
  });
});

describe('withRetry', () => {
  it('retries a 429 and succeeds on the second attempt', async () => {
    const inner = new ScriptedEmbedder([{ status: 429 }, 'ok']);
    const r = await withRetry(inner, FAST).embed('x');
    assert.deepEqual(r.vector, [1]);
    assert.equal(inner.calls, 2);
  });

  it('throws after exhausting attempts', async () => {
    const inner = new ScriptedEmbedder([{ status: 429 }]);
    await assert.rejects(() =>
      withRetry(inner, { ...FAST, maxAttempts: 2 }).embed('x'),
    );
    assert.equal(inner.calls, 3);
  });

  it('does not retry a non-retryable status', async () => {
    const inner = new ScriptedEmbedder([{ status: 400 }]);
    await assert.rejects(() => withRetry(inner, FAST).embed('x'));
    assert.equal(inner.calls, 1);
  });

  it('uses a word-boundary message match as a last resort', async () => {
    const inner = new ScriptedEmbedder([
      new RagError('batchSize of 429 is not allowed', 'EMBED_ERROR'),
    ]);
    const retrying = withRetry(inner, FAST);
    await assert.rejects(() => retrying.embed('x'));
    assert.equal(inner.calls, 4);
  });

  it('preserves batch capability instead of fabricating it', () => {
    assert.equal(
      isBatchEmbedder(withRetry(new ScriptedEmbedder(['ok']))),
      true,
    );
    assert.equal(isBatchEmbedder(withRetry(new EmbedOnly())), false);
  });

  it('stops when the signal is aborted', async () => {
    const inner = new ScriptedEmbedder([{ status: 429 }]);
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(() =>
      withRetry(inner, FAST).embed('x', { signal: ac.signal }),
    );
    assert.equal(inner.calls, 0);
  });
});
