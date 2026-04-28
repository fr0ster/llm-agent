import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { resolveDeploymentId } from './deployments.js';
const originalFetch = globalThis.fetch;
let lastUrl = '';
let lastInit;
beforeEach(() => {
    lastUrl = '';
    lastInit = undefined;
});
afterEach(() => {
    globalThis.fetch = originalFetch;
});
function mockOnce(body, status = 200) {
    globalThis.fetch = (async (url, init) => {
        lastUrl = typeof url === 'string' ? url : url.toString();
        lastInit = init;
        return new Response(JSON.stringify(body), {
            status,
            headers: { 'content-type': 'application/json' },
        });
    });
}
test('resolveDeploymentId returns id of RUNNING deployment matching model name', async () => {
    mockOnce({
        resources: [
            {
                id: 'd-other',
                details: {
                    resources: {
                        backend_details: { model: { name: 'text-embedding-3-small' } },
                    },
                },
            },
            {
                id: 'd-match',
                details: {
                    resources: {
                        backend_details: { model: { name: 'gemini-embedding' } },
                    },
                },
            },
        ],
    });
    const id = await resolveDeploymentId({
        apiBaseUrl: 'https://api.example.com',
        token: 'tok',
        resourceGroup: 'default',
        model: 'gemini-embedding',
    });
    assert.equal(id, 'd-match');
    assert.ok(lastUrl.includes('scenarioId=foundation-models'), `url should filter by scenario, got: ${lastUrl}`);
    assert.ok(lastUrl.includes('status=RUNNING'));
    const headers = lastInit?.headers;
    assert.equal(headers.Authorization, 'Bearer tok');
    assert.equal(headers['AI-Resource-Group'], 'default');
});
test('resolveDeploymentId falls back to top-level model.name when details path is absent', async () => {
    mockOnce({
        resources: [{ id: 'd-fallback', model: { name: 'fallback-model' } }],
    });
    const id = await resolveDeploymentId({
        apiBaseUrl: 'https://api.example.com',
        token: 'tok',
        resourceGroup: 'default',
        model: 'fallback-model',
    });
    assert.equal(id, 'd-fallback');
});
test('resolveDeploymentId throws when no match found', async () => {
    mockOnce({ resources: [] });
    await assert.rejects(() => resolveDeploymentId({
        apiBaseUrl: 'https://api.example.com',
        token: 'tok',
        resourceGroup: 'default',
        model: 'gemini-embedding',
    }), /gemini-embedding.*foundation-models/);
});
test('resolveDeploymentId propagates HTTP errors', async () => {
    mockOnce({ error: 'forbidden' }, 403);
    await assert.rejects(() => resolveDeploymentId({
        apiBaseUrl: 'https://api.example.com',
        token: 'tok',
        resourceGroup: 'default',
        model: 'x',
    }), /403/);
});
//# sourceMappingURL=deployments.test.js.map