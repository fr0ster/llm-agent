import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IUsageRecorder, UsageInput } from '@mcp-abap-adt/llm-agent';
import { OllamaEmbedder } from './ollama.js';

function recorder() {
  const records: UsageInput[] = [];
  const usage: IUsageRecorder = {
    record: (record) => records.push(record),
    with: () => usage,
  };
  return { records, usage };
}

test('physical embedding requests: totals, retries, overrides, aborts and safe errors', async (t) => {
  const bound = recorder();
  const override = recorder();
  const provider = new OllamaEmbedder({ model: 'model', usage: bound.usage });
  let attempt = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    if (attempt++ === 0)
      return new Response('private provider message', { status: 429 });
    return Response.json({
      data: [
        { embedding: [1], index: 0 },
        { embedding: [2], index: 1 },
        { embedding: [3], index: 2 },
      ],
      usage: { prompt_tokens: 5, total_tokens: 5 },
      embeddings: [[1], [2], [3]],
      embedding: [1],
      prompt_eval_count: 5,
    });
  });
  const result = await provider.embedBatch(['private input', 'b', 'c']);
  assert.equal(result.length, 3);
  assert.equal(bound.records.length, 2);
  const records = bound.records.filter(
    (record) => record.kind === 'embedding.call',
  );
  assert.deepEqual(
    records.map((record) => [record.providerAttempt, record.outcome]),
    [
      [0, 'error'],
      [1, 'ok'],
    ],
  );
  assert.equal(records[0].operationId, records[1].operationId);
  assert.equal(records[1].inputTokens, 5);
  assert.equal(records[1].tokensSource, 'provider');
  assert.equal(records[0].errorCode, '429');
  assert.ok(!JSON.stringify(bound.records).includes('private'));
  await provider.embed('a', { usage: override.usage });
  assert.equal(bound.records.length, 2);
  assert.equal(override.records.length, 1);
  t.mock.method(globalThis, 'fetch', async () => {
    throw new DOMException('private abort', 'AbortError');
  });
  await assert.rejects(provider.embed('a'));
  assert.equal(bound.records.at(-1)?.outcome, 'aborted');
  t.mock.method(globalThis, 'fetch', async () => {
    throw Object.assign(new Error('private thrown'), { code: 'ECONNRESET' });
  });
  await assert.rejects(provider.embed('a'));
  assert.deepEqual(
    bound.records.slice(-3).map((record) => record.outcome),
    ['error', 'error', 'error'],
  );
  assert.equal(bound.records.at(-1)?.errorCode, 'ECONNRESET');
});
