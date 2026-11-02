import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isBatchEmbedder } from '../interfaces/rag.js';
import { composeResilientEmbedder } from './embedder-resilience.js';

test('single embedding input is capped before the provider, preserving the beginning', async () => {
  const received: string[] = [];
  const provider = {
    embed: async (text: string) => {
      received.push(text);
      return { vector: [0] };
    },
  };
  const embedder = composeResilientEmbedder(provider);
  await embedder.embed('a'.repeat(41903));
  await embedder.embed('short');
  assert.deepEqual(received, ['a'.repeat(24000), 'short']);
  await composeResilientEmbedder(provider, { maxInputChars: 3 }).embed(
    'abcdef',
  );
  await composeResilientEmbedder(provider, { maxInputChars: 0 }).embed(
    'abcdef',
  );
  assert.deepEqual(received.slice(2), ['abc', 'abcdef']);
  assert.equal(isBatchEmbedder(embedder), false);
});

test('input-too-long failures are never retried even when carrying a retryable status', async () => {
  let calls = 0;
  const embedder = composeResilientEmbedder(
    {
      embed: async () => {
        calls++;
        throw Object.assign(new Error('Input too long'), { status: 503 });
      },
    },
    { retry: { backoffMs: 0 } },
  );
  await assert.rejects(embedder.embed('text'));
  assert.equal(calls, 1);
});
