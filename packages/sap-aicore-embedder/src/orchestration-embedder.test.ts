import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IBearerCredential } from '@mcp-abap-adt/interfaces-auth';
import { OrchestrationScenarioEmbedder } from './orchestration-embedder.js';

/**
 * Regression coverage for the destination wiring `createClient()` builds
 * from `credential`/`apiBaseUrl` (mirrors
 * `sap-aicore-llm/src/__tests__/sap-core-ai-provider.test.ts`'s "asks the
 * credential for a fresh token on every call" test, which spies on
 * `createClient` the same way).
 *
 * Without this file, all 22 pre-existing `sap-aicore-embedder` tests pass
 * even if `buildDestination()` and the third `OrchestrationEmbeddingClient`
 * constructor argument are deleted outright and the pre-task two-argument
 * call is restored — proven by reverting that wiring locally and re-running
 * the suite (see the task report's "Fix round 1" section for the transcript).
 */

const fakeEmbedResponse = () => ({
  getEmbeddings: () => [{ embedding: [0], index: 0 }],
});

test('embed(): builds a fresh destination (credential.token()) on every call, not cached at construction', async () => {
  let n = 0;
  const credential: IBearerCredential = {
    kind: 'bearer',
    token: async () => `tok${++n}`,
  };
  const emb = new OrchestrationScenarioEmbedder({
    model: 'text-embedding-3-small',
    credential,
    apiBaseUrl: 'https://api.example.com',
  });

  const seenDestinations: Array<{
    url: string;
    authentication: string;
    Authorization: string;
  }> = [];
  // biome-ignore lint/suspicious/noExplicitAny: test spy on the private createClient() method
  (emb as any).createClient = async (destination: {
    url: string;
    authentication: string;
    headers: { Authorization: string };
  }) => {
    seenDestinations.push({
      url: destination.url,
      authentication: destination.authentication,
      Authorization: destination.headers.Authorization,
    });
    return { embed: async () => fakeEmbedResponse() };
  };

  await emb.embed('a');
  await emb.embed('b');

  assert.deepEqual(
    seenDestinations.map((d) => d.Authorization),
    ['Bearer tok1', 'Bearer tok2'],
    'each embed() call must ask credential.token() fresh, not reuse a value cached at construction',
  );
  for (const d of seenDestinations) {
    assert.equal(d.url, 'https://api.example.com');
    assert.equal(d.authentication, 'NoAuthentication');
  }
});

test('embedBatch(): builds a fresh destination on every call', async () => {
  let n = 0;
  const credential: IBearerCredential = {
    kind: 'bearer',
    token: async () => `b${++n}`,
  };
  const emb = new OrchestrationScenarioEmbedder({
    model: 'text-embedding-3-small',
    credential,
    apiBaseUrl: 'https://api.example.com',
  });

  const seenAuth: string[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: test spy on the private createClient() method
  (emb as any).createClient = async (destination: {
    headers: { Authorization: string };
  }) => {
    seenAuth.push(destination.headers.Authorization);
    return { embed: async () => fakeEmbedResponse() };
  };

  await emb.embedBatch(['x', 'y']);
  await emb.embedBatch(['z']);

  assert.deepEqual(seenAuth, ['Bearer b1', 'Bearer b2']);
});
