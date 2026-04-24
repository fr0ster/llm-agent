// packages/sap-aicore-embedder/src/foundation-embedder.test.ts
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { FoundationModelsEmbedder } from './foundation-embedder.js';

const originalFetch = globalThis.fetch;
interface Call {
  url: string;
  init?: RequestInit;
}
let calls: Call[] = [];

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function installFetch(
  handler: (
    url: string,
    init?: RequestInit,
  ) => { body: unknown; status?: number },
) {
  globalThis.fetch = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    const u = typeof url === 'string' ? url : url.toString();
    calls.push({ url: u, init });
    const { body, status = 200 } = handler(u, init);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

function makeEmbedder() {
  return new FoundationModelsEmbedder({
    model: 'gemini-embedding',
    resourceGroup: 'default',
    credentials: {
      clientId: 'cid',
      clientSecret: 'csec',
      tokenUrl: 'https://auth.example.com/oauth/token',
      apiBaseUrl: 'https://api.example.com',
    },
  });
}

test('embed: resolves deployment, fetches token, returns vector', async () => {
  installFetch((url) => {
    if (url.endsWith('/oauth/token')) {
      return { body: { access_token: 'tok', expires_in: 3600 } };
    }
    if (url.includes('/v2/lm/deployments')) {
      return {
        body: {
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
        },
      };
    }
    if (url.endsWith('/v2/inference/deployments/d-1/embeddings')) {
      return { body: { data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }] } };
    }
    throw new Error(`unexpected url ${url}`);
  });

  const result = await makeEmbedder().embed('hello');
  assert.deepEqual(result.vector, [0.1, 0.2, 0.3]);
});

test('embed: decodes base64 embedding', async () => {
  const floats = new Float32Array([1, 2, 3]);
  const base64 = Buffer.from(floats.buffer).toString('base64');

  installFetch((url) => {
    if (url.endsWith('/oauth/token'))
      return { body: { access_token: 'tok', expires_in: 3600 } };
    if (url.includes('/v2/lm/deployments')) {
      return {
        body: {
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
        },
      };
    }
    return { body: { data: [{ embedding: base64, index: 0 }] } };
  });

  const result = await makeEmbedder().embed('hello');
  assert.deepEqual(Array.from(result.vector), [1, 2, 3]);
});

test('embedBatch: sorts by index and returns vectors in input order', async () => {
  installFetch((url) => {
    if (url.endsWith('/oauth/token'))
      return { body: { access_token: 'tok', expires_in: 3600 } };
    if (url.includes('/v2/lm/deployments')) {
      return {
        body: {
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
        },
      };
    }
    return {
      body: {
        data: [
          { embedding: [2, 2], index: 1 },
          { embedding: [1, 1], index: 0 },
        ],
      },
    };
  });

  const result = await makeEmbedder().embedBatch(['a', 'b']);
  assert.deepEqual(result[0].vector, [1, 1]);
  assert.deepEqual(result[1].vector, [2, 2]);
});

test('embedBatch: returns [] for empty input without fetching', async () => {
  installFetch(() => {
    throw new Error('fetch should not be called');
  });
  const result = await makeEmbedder().embedBatch([]);
  assert.deepEqual(result, []);
});

test('deployment id is cached across calls', async () => {
  let deploymentCalls = 0;
  installFetch((url) => {
    if (url.endsWith('/oauth/token'))
      return { body: { access_token: 'tok', expires_in: 3600 } };
    if (url.includes('/v2/lm/deployments')) {
      deploymentCalls++;
      return {
        body: {
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
        },
      };
    }
    return { body: { data: [{ embedding: [0], index: 0 }] } };
  });

  const emb = makeEmbedder();
  await emb.embed('x');
  await emb.embed('y');
  assert.equal(deploymentCalls, 1);
});

test('embeddings request uses Bearer + AI-Resource-Group headers', async () => {
  installFetch((url) => {
    if (url.endsWith('/oauth/token'))
      return { body: { access_token: 'tok', expires_in: 3600 } };
    if (url.includes('/v2/lm/deployments')) {
      return {
        body: {
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
        },
      };
    }
    return { body: { data: [{ embedding: [0], index: 0 }] } };
  });

  await makeEmbedder().embed('x');

  const embedCall = calls.find((c) => c.url.endsWith('/embeddings'));
  assert.ok(embedCall, 'expected an embeddings call');
  const headers = embedCall.init?.headers as Record<string, string>;
  assert.equal(headers.Authorization, 'Bearer tok');
  assert.equal(headers['AI-Resource-Group'], 'default');
  assert.equal(embedCall.init?.method, 'POST');
});
