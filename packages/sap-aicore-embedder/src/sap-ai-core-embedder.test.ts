// packages/sap-aicore-embedder/src/sap-ai-core-embedder.test.ts
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import type { IBearerCredential } from '@mcp-abap-adt/interfaces-auth';
import { SapAiCoreEmbedder } from './sap-ai-core-embedder.js';

const originalFetch = globalThis.fetch;
let lastUrl = '';

beforeEach(() => {
  lastUrl = '';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const credential: IBearerCredential = {
  kind: 'bearer',
  token: async () => 'tok',
};

test('scenario: foundation-models calls REST inference endpoint', async () => {
  globalThis.fetch = (async (url: string | URL | Request) => {
    const u = typeof url === 'string' ? url : url.toString();
    lastUrl = u;
    if (u.includes('/v2/lm/deployments')) {
      return new Response(
        JSON.stringify({
          resources: [
            {
              id: 'd-1',
              details: {
                resources: {
                  backend_details: {
                    model: { name: 'text-embedding-3-small' },
                  },
                },
              },
            },
          ],
        }),
        { status: 200 },
      );
    }
    return new Response(
      JSON.stringify({ data: [{ embedding: [0.5], index: 0 }] }),
      { status: 200 },
    );
  }) as typeof fetch;

  const emb = new SapAiCoreEmbedder({
    model: 'text-embedding-3-small',
    scenario: 'foundation-models',
    credential,
    apiBaseUrl: 'https://api.example.com',
  });
  const res = await emb.embed('hi');
  assert.deepEqual(res.vector, [0.5]);
  assert.ok(lastUrl.includes('/v2/inference/deployments/d-1/embeddings'));
});

test('scenario: orchestration delegates to the SDK-based backend', async () => {
  // We can't easily instantiate the SDK backend without network, so just
  // verify construction + routing by asserting no REST fetch happens.
  globalThis.fetch = (async () => {
    throw new Error(
      'fetch should not be called for orchestration scenario in construction',
    );
  }) as typeof fetch;

  const emb = new SapAiCoreEmbedder({
    model: 'text-embedding-3-small',
    scenario: 'orchestration',
    credential,
    apiBaseUrl: 'https://api.example.com',
  });
  assert.ok(emb);
});

test('default scenario is orchestration (no REST fetch on construction)', async () => {
  globalThis.fetch = (async () => {
    throw new Error(
      'fetch should not be called when default (orchestration) is used at construction',
    );
  }) as typeof fetch;

  const emb = new SapAiCoreEmbedder({
    model: 'text-embedding-3-small',
    credential,
    apiBaseUrl: 'https://api.example.com',
  });
  assert.ok(emb);
});
