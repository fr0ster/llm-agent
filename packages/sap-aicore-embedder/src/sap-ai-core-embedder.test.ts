// packages/sap-aicore-embedder/src/sap-ai-core-embedder.test.ts
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, test } from 'node:test';
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

// ---------------------------------------------------------------------------
// Asymmetric models: the input `type`
// ---------------------------------------------------------------------------

describe('SapAiCoreEmbedder — input type', () => {
  const base = {
    model: 'nvidia--llama-3.2-nv-embedqa-1b',
    credential: { kind: 'bearer' as const, token: async () => 't' },
    apiBaseUrl: 'https://api.example.com',
  };
  /** Spy on the orchestration backend's client: what each embed call sends. */
  const spy = (emb: object) => {
    const sent: unknown[] = [];
    // biome-ignore lint/suspicious/noExplicitAny: test spy on the private backend/createClient
    (emb as any).backend.createClient = async () => ({
      embed: async (req: unknown) => {
        sent.push(req);
        return {
          getEmbeddings: () => [
            { embedding: [1], index: 0 },
            { embedding: [2], index: 1 },
          ],
        };
      },
    });
    return sent;
  };

  it('sends no type when none is configured', async () => {
    const emb = new SapAiCoreEmbedder(base);
    const sent = spy(emb);
    await emb.embed('a');
    assert.deepEqual(sent, [{ input: 'a' }]);
  });

  it("inputType 'document' sends type document, on embed and embedBatch", async () => {
    const emb = new SapAiCoreEmbedder({ ...base, inputType: 'document' });
    const sent = spy(emb);
    await emb.embed('a');
    await emb.embedBatch(['a', 'b']);
    assert.deepEqual(sent, [
      { input: 'a', type: 'document' },
      { input: ['a', 'b'], type: 'document' },
    ]);
  });

  it("inputType 'query' sends type query", async () => {
    const emb = new SapAiCoreEmbedder({ ...base, inputType: 'query' });
    const sent = spy(emb);
    await emb.embed('q');
    assert.deepEqual(sent, [{ input: 'q', type: 'query' }]);
  });

  it('refuses an input type on the foundation-models scenario', () => {
    assert.throws(
      () =>
        new SapAiCoreEmbedder({
          ...base,
          inputType: 'query',
          scenario: 'foundation-models',
        }),
      /inputType is supported with scenario 'orchestration' only/,
    );
  });
});
