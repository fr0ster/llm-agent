import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MODEL_CONTEXT_EXCEEDED, RagError } from '../../interfaces/types.js';
import { CircuitBreaker } from '../../resilience/circuit-breaker.js';
import { FallbackRag } from '../../resilience/fallback-rag.js';
import { InMemoryRag } from '../in-memory-rag.js';
import { FallbackQueryEmbedding } from '../query-embedding.js';
import { retryRagThrottle } from '../record-embedding.js';

const overflow = new RagError('Prompt too long', MODEL_CONTEXT_EXCEEDED);

test('fallback query embedding stops on wrapped overflow', async () => {
  let fallbackCalls = 0;
  const embedding = new FallbackQueryEmbedding(
    {
      text: 'prompt',
      async toVector() {
        throw new Error('Provider wrapper', { cause: overflow });
      },
    },
    {
      async embedQuery() {
        fallbackCalls++;
        return { vector: [1] };
      },
    },
  );
  await assert.rejects(embedding.toVector(), (error) => error === overflow);
  assert.equal(fallbackCalls, 0);
});

test('fallback store does not hide a returned getById overflow', async () => {
  const primary = new InMemoryRag();
  primary.getById = async () => ({ ok: false, error: overflow });
  const fallback = new InMemoryRag();
  let fallbackCalls = 0;
  fallback.getById = async () => {
    fallbackCalls++;
    return { ok: true, value: null };
  };
  const store = new FallbackRag(primary, fallback, new CircuitBreaker());
  assert.deepEqual(await store.getById('record'), {
    ok: false,
    error: overflow,
  });
  assert.equal(fallbackCalls, 0);
});

test('RAG throttle retry preserves overflow when the signal aborts during the call', async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(
    retryRagThrottle(async () => {
      calls++;
      controller.abort();
      throw Object.assign(new Error('Provider wrapper', { cause: overflow }), {
        status: 429,
      });
    }, controller.signal),
    (error) => error === overflow,
  );
  assert.equal(calls, 1);
});
