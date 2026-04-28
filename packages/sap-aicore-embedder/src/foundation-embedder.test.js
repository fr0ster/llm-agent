import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { FoundationModelsEmbedder } from './foundation-embedder.js';
const originalFetch = globalThis.fetch;
let calls = [];
beforeEach(() => {
    calls = [];
});
afterEach(() => {
    globalThis.fetch = originalFetch;
});
function installFetch(handler) {
    globalThis.fetch = (async (url, init) => {
        const u = typeof url === 'string' ? url : url.toString();
        calls.push({ url: u, init });
        const { body, status = 200 } = handler(u, init);
        return new Response(JSON.stringify(body), {
            status,
            headers: { 'content-type': 'application/json' },
        });
    });
}
function deploymentList(modelName, id = 'd-1') {
    return {
        resources: [
            {
                id,
                details: {
                    resources: { backend_details: { model: { name: modelName } } },
                },
            },
        ],
    };
}
function makeOpenAiEmbedder() {
    return new FoundationModelsEmbedder({
        model: 'text-embedding-3-small',
        resourceGroup: 'default',
        credentials: {
            clientId: 'cid',
            clientSecret: 'csec',
            tokenUrl: 'https://auth.example.com/oauth/token',
            apiBaseUrl: 'https://api.example.com',
        },
    });
}
function makeGeminiEmbedder() {
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
// ---------------------------------------------------------------------------
// OpenAI / Azure path
// ---------------------------------------------------------------------------
test('openai: embed posts to /embeddings?api-version=... and returns vector', async () => {
    installFetch((url) => {
        if (url.endsWith('/oauth/token'))
            return { body: { access_token: 'tok', expires_in: 3600 } };
        if (url.includes('/v2/lm/deployments'))
            return { body: deploymentList('text-embedding-3-small') };
        return { body: { data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }] } };
    });
    const result = await makeOpenAiEmbedder().embed('hello');
    assert.deepEqual(result.vector, [0.1, 0.2, 0.3]);
    const embedCall = calls.find((c) => c.url.includes('/embeddings'));
    assert.ok(embedCall);
    assert.ok(embedCall.url.includes('api-version=2023-05-15'), `expected api-version in URL, got ${embedCall.url}`);
});
test('openai: decodes base64 embedding', async () => {
    const floats = new Float32Array([1, 2, 3]);
    const base64 = Buffer.from(floats.buffer).toString('base64');
    installFetch((url) => {
        if (url.endsWith('/oauth/token'))
            return { body: { access_token: 'tok', expires_in: 3600 } };
        if (url.includes('/v2/lm/deployments'))
            return { body: deploymentList('text-embedding-3-small') };
        return { body: { data: [{ embedding: base64, index: 0 }] } };
    });
    const result = await makeOpenAiEmbedder().embed('hello');
    assert.deepEqual(Array.from(result.vector), [1, 2, 3]);
});
test('openai: embedBatch sorts by index and returns vectors in input order', async () => {
    installFetch((url) => {
        if (url.endsWith('/oauth/token'))
            return { body: { access_token: 'tok', expires_in: 3600 } };
        if (url.includes('/v2/lm/deployments'))
            return { body: deploymentList('text-embedding-3-small') };
        return {
            body: {
                data: [
                    { embedding: [2, 2], index: 1 },
                    { embedding: [1, 1], index: 0 },
                ],
            },
        };
    });
    const result = await makeOpenAiEmbedder().embedBatch(['a', 'b']);
    assert.deepEqual(result[0].vector, [1, 1]);
    assert.deepEqual(result[1].vector, [2, 2]);
});
test('openai: custom azureApiVersion overrides default', async () => {
    installFetch((url) => {
        if (url.endsWith('/oauth/token'))
            return { body: { access_token: 'tok', expires_in: 3600 } };
        if (url.includes('/v2/lm/deployments'))
            return { body: deploymentList('text-embedding-3-small') };
        return { body: { data: [{ embedding: [0], index: 0 }] } };
    });
    const emb = new FoundationModelsEmbedder({
        model: 'text-embedding-3-small',
        azureApiVersion: '2024-02-15-preview',
        credentials: {
            clientId: 'cid',
            clientSecret: 'csec',
            tokenUrl: 'https://auth.example.com/oauth/token',
            apiBaseUrl: 'https://api.example.com',
        },
    });
    await emb.embed('x');
    const embedCall = calls.find((c) => c.url.includes('/embeddings'));
    assert.ok(embedCall?.url.includes('api-version=2024-02-15-preview'));
});
// ---------------------------------------------------------------------------
// Gemini path
// ---------------------------------------------------------------------------
test('gemini: embed posts to /models/<model>:predict and returns vector', async () => {
    installFetch((url) => {
        if (url.endsWith('/oauth/token'))
            return { body: { access_token: 'tok', expires_in: 3600 } };
        if (url.includes('/v2/lm/deployments'))
            return { body: deploymentList('gemini-embedding') };
        return {
            body: {
                predictions: [{ embeddings: { values: [0.5, 0.6, 0.7] } }],
            },
        };
    });
    const result = await makeGeminiEmbedder().embed('hello');
    assert.deepEqual(result.vector, [0.5, 0.6, 0.7]);
    const embedCall = calls.find((c) => c.url.includes(':predict'));
    assert.ok(embedCall);
    assert.ok(embedCall.url.endsWith('/models/gemini-embedding:predict'));
});
test('gemini: embedBatch returns vectors in input order', async () => {
    installFetch((url) => {
        if (url.endsWith('/oauth/token'))
            return { body: { access_token: 'tok', expires_in: 3600 } };
        if (url.includes('/v2/lm/deployments'))
            return { body: deploymentList('gemini-embedding') };
        return {
            body: {
                predictions: [
                    { embeddings: { values: [1, 1] } },
                    { embeddings: { values: [2, 2] } },
                ],
            },
        };
    });
    const result = await makeGeminiEmbedder().embedBatch(['a', 'b']);
    assert.deepEqual(result[0].vector, [1, 1]);
    assert.deepEqual(result[1].vector, [2, 2]);
});
test('gemini: request body shape uses instances[].content', async () => {
    installFetch((url) => {
        if (url.endsWith('/oauth/token'))
            return { body: { access_token: 'tok', expires_in: 3600 } };
        if (url.includes('/v2/lm/deployments'))
            return { body: deploymentList('gemini-embedding') };
        return {
            body: { predictions: [{ embeddings: { values: [0] } }] },
        };
    });
    await makeGeminiEmbedder().embed('hi');
    const embedCall = calls.find((c) => c.url.includes(':predict'));
    assert.ok(embedCall);
    const body = JSON.parse(embedCall.init?.body);
    assert.deepEqual(body, { instances: [{ content: 'hi' }] });
});
// ---------------------------------------------------------------------------
// Common
// ---------------------------------------------------------------------------
test('embedBatch: returns [] for empty input without fetching', async () => {
    installFetch(() => {
        throw new Error('fetch should not be called');
    });
    const result = await makeOpenAiEmbedder().embedBatch([]);
    assert.deepEqual(result, []);
});
test('deployment id is cached across calls', async () => {
    let deploymentCalls = 0;
    installFetch((url) => {
        if (url.endsWith('/oauth/token'))
            return { body: { access_token: 'tok', expires_in: 3600 } };
        if (url.includes('/v2/lm/deployments')) {
            deploymentCalls++;
            return { body: deploymentList('text-embedding-3-small') };
        }
        return { body: { data: [{ embedding: [0], index: 0 }] } };
    });
    const emb = makeOpenAiEmbedder();
    await emb.embed('x');
    await emb.embed('y');
    assert.equal(deploymentCalls, 1);
});
test('embeddings request uses Bearer + AI-Resource-Group headers', async () => {
    installFetch((url) => {
        if (url.endsWith('/oauth/token'))
            return { body: { access_token: 'tok', expires_in: 3600 } };
        if (url.includes('/v2/lm/deployments'))
            return { body: deploymentList('text-embedding-3-small') };
        return { body: { data: [{ embedding: [0], index: 0 }] } };
    });
    await makeOpenAiEmbedder().embed('x');
    const embedCall = calls.find((c) => c.url.includes('/embeddings'));
    assert.ok(embedCall, 'expected an embeddings call');
    const headers = embedCall.init?.headers;
    assert.equal(headers.Authorization, 'Bearer tok');
    assert.equal(headers['AI-Resource-Group'], 'default');
    assert.equal(embedCall.init?.method, 'POST');
});
//# sourceMappingURL=foundation-embedder.test.js.map