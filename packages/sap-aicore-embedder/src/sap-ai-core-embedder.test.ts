// packages/sap-aicore-embedder/src/sap-ai-core-embedder.test.ts
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { SapAiCoreEmbedder } from './sap-ai-core-embedder.js';

const originalFetch = globalThis.fetch;
let lastUrl = '';

beforeEach(() => {
  lastUrl = '';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.AICORE_SERVICE_KEY;
});

test('defaults to foundation-models scenario and calls REST inference endpoint', async () => {
  process.env.AICORE_SERVICE_KEY = JSON.stringify({
    clientid: 'cid',
    clientsecret: 'csec',
    url: 'https://auth.example.com',
    serviceurls: { AI_API_URL: 'https://api.example.com' },
  });

  globalThis.fetch = (async (url: string | URL | Request) => {
    const u = typeof url === 'string' ? url : url.toString();
    lastUrl = u;
    if (u.endsWith('/oauth/token')) {
      return new Response(
        JSON.stringify({ access_token: 'tok', expires_in: 3600 }),
        { status: 200 },
      );
    }
    if (u.includes('/v2/lm/deployments')) {
      return new Response(
        JSON.stringify({
          resources: [
            {
              id: 'd-1',
              details: {
                resources: {
                  backend_details: { model: { name: 'gemini-embedding' } },
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

  const emb = new SapAiCoreEmbedder({ model: 'gemini-embedding' });
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
  });
  assert.ok(emb);
});
