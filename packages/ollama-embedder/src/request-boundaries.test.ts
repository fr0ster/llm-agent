import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IUsageRecorder, UsageInput } from '@mcp-abap-adt/llm-agent';
import { OllamaEmbedder } from './ollama.js';

test('unusable HTTP 200 responses record an error for each physical request in single and batch paths', async (t) => {
  const records: UsageInput[] = [];
  const usage: IUsageRecorder = {
    record: (r) => records.push(r),
    with: () => usage,
  };
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    return Response.json({ embedding: null, embeddings: [null] });
  });
  // Skip only the backoff delay, preserving all physical retry attempts.
  t.mock.method(globalThis, 'setTimeout', (callback: () => void) => {
    callback();
    return undefined as unknown as ReturnType<typeof setTimeout>;
  });
  const provider = new OllamaEmbedder({ model: 'test', usage });
  for (const batch of [false, true]) {
    records.length = 0;
    requests = 0;
    await assert.rejects(
      batch ? provider.embedBatch(['a']) : provider.embed('a'),
    );
    assert.equal(requests, 3);
    assert.equal(records.length, requests);
    assert.ok(records.every((r) => r.outcome === 'error'));
  }
});
