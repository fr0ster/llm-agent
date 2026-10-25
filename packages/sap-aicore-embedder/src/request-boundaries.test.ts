import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IUsageRecorder, UsageInput } from '@mcp-abap-adt/llm-agent';
import { FoundationModelsEmbedder } from './foundation-embedder.js';
import { OrchestrationScenarioEmbedder } from './orchestration-embedder.js';

for (const variant of ['azure', 'gemini', 'orchestration']) {
  test(`${variant}: processing finishes before success; credentials and setup precede request records`, async (t) => {
    const records: UsageInput[] = [];
    const usage: IUsageRecorder = {
      record: (r) => records.push(r),
      with: () => usage,
    };
    let rejectCredential = false;
    let rejectSetup = false;
    let requests = 0;
    const config = {
      model: variant === 'gemini' ? 'gemini-test' : 'test',
      apiBaseUrl: 'https://example.invalid',
      usage,
      credential: {
        kind: 'bearer' as const,
        token: async () => {
          if (rejectCredential) throw new Error('credential rejected');
          return 'secret';
        },
      },
    };
    const provider =
      variant === 'orchestration'
        ? new OrchestrationScenarioEmbedder(config)
        : new FoundationModelsEmbedder(config);
    Object.assign(provider, {
      deploymentIdPromise: Promise.resolve('deployment'),
      createClient: async () => {
        if (rejectSetup) throw new Error('setup rejected');
        return {
          embed: async () => {
            requests++;
            return {
              getEmbeddings: () => [{ index: 0, embedding: null }],
              getTokenUsage: () => ({ prompt_tokens: 5 }),
            };
          },
        };
      },
    });
    t.mock.method(globalThis, 'fetch', async () => {
      requests++;
      return Response.json(
        variant === 'gemini'
          ? { predictions: [{ embeddings: { values: null } }] }
          : { data: [{ index: 0, embedding: null }] },
      );
    });
    for (const batch of [false, true]) {
      records.length = 0;
      requests = 0;
      await assert.rejects(
        batch ? provider.embedBatch(['a']) : provider.embed('a'),
      );
      assert.equal(requests, 1);
      assert.deepEqual(
        records.map((r) => r.outcome),
        ['error'],
      );
    }
    records.length = 0;
    requests = 0;
    rejectCredential = true;
    await assert.rejects(provider.embed('a'), /credential rejected/);
    await assert.rejects(provider.embedBatch(['a']), /credential rejected/);
    assert.equal(requests, 0);
    assert.equal(records.length, 0);
    if (variant === 'orchestration') {
      rejectCredential = false;
      rejectSetup = true;
      await assert.rejects(provider.embed('a'), /setup rejected/);
      await assert.rejects(provider.embedBatch(['a']), /setup rejected/);
      assert.equal(requests, 0);
      assert.equal(records.length, 0);
    }
  });
}
