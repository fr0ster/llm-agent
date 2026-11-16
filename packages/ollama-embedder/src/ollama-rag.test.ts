import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DefaultWaitStrategy,
  type IUsageRecorder,
  type UsageInput,
} from '@mcp-abap-adt/llm-agent';
import { OllamaRag } from './ollama.js';

test('OllamaRag retains retries through core composition with one request per attempt', async (t) => {
  const waits: number[] = [];
  t.mock.method(DefaultWaitStrategy.prototype, 'wait', async (ms: number) => {
    waits.push(ms);
    return 'elapsed';
  });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    if (++calls === 1) return new Response('unavailable', { status: 503 });
    return Response.json({ embedding: [1] });
  });
  const records: UsageInput[] = [];
  const usage: IUsageRecorder = {
    record: (record) => records.push(record),
    with: () => usage,
  };
  const rag = new OllamaRag({ model: 'test', usage });
  assert.equal((await rag.upsert('q', {})).ok, true);
  assert.equal(calls, 2);
  assert.deepEqual(waits, [2000]);
  assert.deepEqual(
    records
      .filter((r) => r.kind === 'embedding.call')
      .map((r) => [r.outerAttempt, r.providerAttempt, r.outcome]),
    [
      [0, 0, 'error'],
      [1, 0, 'ok'],
    ],
  );
});
