// packages/sap-aicore-embedder/src/bearer-credential.test.ts
//
// Colocated with the rest of this package's tests (no `__tests__/` dir here),
// mirroring `packages/sap-aicore-llm/src/__tests__/bearer-credential.test.ts`.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { IBearerCredential } from '@mcp-abap-adt/interfaces-auth';
import { FoundationModelsEmbedder } from './foundation-embedder.js';
import { SapAiCoreEmbedder } from './sap-ai-core-embedder.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.AICORE_SERVICE_KEY;
});

test('foundation-models: asks the credential per call and never reads AICORE_SERVICE_KEY', async () => {
  // Deliberately poison the env var so a fallback read would be caught.
  process.env.AICORE_SERVICE_KEY = 'not-json-and-should-never-be-parsed';

  let n = 0;
  const credential: IBearerCredential = {
    kind: 'bearer',
    token: async () => `t${++n}`,
  };
  const seenAuth: string[] = [];
  globalThis.fetch = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    const u = typeof url === 'string' ? url : url.toString();
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
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seenAuth.push(headers.Authorization);
    return new Response(
      JSON.stringify({ data: [{ embedding: [0], index: 0 }] }),
      {
        status: 200,
      },
    );
  }) as typeof fetch;

  const emb = new FoundationModelsEmbedder({
    model: 'text-embedding-3-small',
    credential,
    apiBaseUrl: 'https://api.example.com',
  });
  await emb.embed('a');
  await emb.embed('b');

  assert.deepEqual(seenAuth, ['Bearer t1', 'Bearer t2']);
});

test('SapAiCoreEmbedder construction never touches AICORE_SERVICE_KEY for either scenario', () => {
  // No env var set at all — construction must not throw for either scenario,
  // because the credential and apiBaseUrl are supplied explicitly.
  delete process.env.AICORE_SERVICE_KEY;
  const credential: IBearerCredential = {
    kind: 'bearer',
    token: async () => 'x',
  };

  assert.doesNotThrow(
    () =>
      new SapAiCoreEmbedder({
        model: 'text-embedding-3-small',
        scenario: 'foundation-models',
        credential,
        apiBaseUrl: 'https://api.example.com',
      }),
  );
  assert.doesNotThrow(
    () =>
      new SapAiCoreEmbedder({
        model: 'text-embedding-3-small',
        scenario: 'orchestration',
        credential,
        apiBaseUrl: 'https://api.example.com',
      }),
  );
});
