import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IUsageRecorder, UsageInput } from '@mcp-abap-adt/llm-agent';
import { FoundationModelsEmbedder } from './foundation-embedder.js';
import { OrchestrationScenarioEmbedder } from './orchestration-embedder.js';

function recorder() {
  const records: UsageInput[] = [];
  const usage: IUsageRecorder = {
    record: (record) => records.push(record),
    with: () => usage,
  };
  return { records, usage };
}
const credential = { kind: 'bearer' as const, token: async () => 'secret' };

test('foundation records exact Azure totals and every failed inference request', async (t) => {
  const bound = recorder();
  const override = recorder();
  const provider = new FoundationModelsEmbedder({
    model: 'model',
    credential,
    apiBaseUrl: 'https://example.test',
    usage: bound.usage,
  });
  // Deployment discovery is control-plane traffic, not an embedding request.
  Object.assign(provider, {
    deploymentIdPromise: Promise.resolve('deployment'),
  });
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({
      data: [
        { embedding: [1], index: 0 },
        { embedding: [2], index: 1 },
        { embedding: [3], index: 2 },
      ],
      usage: { prompt_tokens: 5 },
    }),
  );
  await provider.embedBatch(['private input', 'b', 'c']);
  assert.equal(bound.records.length, 1);
  const record = bound.records[0];
  assert.equal(record.kind, 'embedding.call');
  if (record.kind !== 'embedding.call') throw new Error('wrong kind');
  assert.equal(record.inputTokens, 5);
  assert.equal(record.granularity, 'request');
  await provider.embed('a', { usage: override.usage });
  assert.equal(bound.records.length, 1);
  assert.equal(override.records.length, 1);
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response('private message', { status: 429 }),
  );
  await assert.rejects(provider.embed('a'));
  assert.equal(bound.records.at(-1)?.errorCode, '429');
  t.mock.method(globalThis, 'fetch', async () => {
    throw new DOMException('private abort', 'AbortError');
  });
  await assert.rejects(provider.embed('a'));
  assert.equal(bound.records.at(-1)?.outcome, 'aborted');
  assert.ok(!JSON.stringify(bound.records).includes('private'));
});

test('orchestration records exact SDK usage, returned errors, thrown errors and aborts', async () => {
  const bound = recorder();
  const override = recorder();
  const provider = new OrchestrationScenarioEmbedder({
    model: 'model',
    credential,
    apiBaseUrl: 'https://example.test',
    usage: bound.usage,
  });
  let mode = 'ok';
  Object.assign(provider, {
    createClient: async () => ({
      embed: async (_input: unknown, config: { middleware: unknown[] }) => {
        assert.deepEqual(config.middleware, []);
        if (mode === 'throw')
          throw Object.assign(new Error('private message'), { code: 'EFAIL' });
        if (mode === 'abort')
          throw new DOMException('private abort', 'AbortError');
        return {
          getEmbeddings: () =>
            mode === 'empty' ? [] : [{ embedding: [1], index: 0 }],
          getTokenUsage: () => ({ prompt_tokens: 5, total_tokens: 5 }),
        };
      },
    }),
  });
  await provider.embedBatch(['private input', 'b', 'c']);
  const record = bound.records[0];
  assert.equal(record.kind, 'embedding.call');
  if (record.kind !== 'embedding.call') throw new Error('wrong kind');
  assert.equal(record.inputTokens, 5);
  assert.equal(record.granularity, 'request');
  assert.equal(record.retriesVisible, true);
  await provider.embed('a', { usage: override.usage });
  assert.equal(bound.records.length, 1);
  assert.equal(override.records.length, 1);
  for (mode of ['empty', 'throw', 'abort'])
    await assert.rejects(provider.embed('a'));
  assert.deepEqual(
    bound.records.map((record) => record.outcome),
    ['ok', 'error', 'error', 'aborted'],
  );
  assert.equal(bound.records[2].errorCode, 'EFAIL');
  assert.ok(!JSON.stringify(bound.records).includes('private'));
});
