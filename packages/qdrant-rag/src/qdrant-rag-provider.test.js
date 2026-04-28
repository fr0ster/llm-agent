import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import { UnsupportedScopeError } from '@mcp-abap-adt/llm-agent';
import { QdrantRag } from './qdrant-rag.js';
import { QdrantRagProvider } from './qdrant-rag-provider.js';
function makeEmbedder(dim = 3) {
    return {
        async embed(text) {
            let hash = 0;
            for (const ch of text)
                hash = (hash * 31 + ch.charCodeAt(0)) | 0;
            return {
                vector: Array.from({ length: dim }, (_, i) => ((hash >> i) & 0xff) / 255),
            };
        },
    };
}
function createStubServer(state) {
    return http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => {
            body += c;
        });
        req.on('end', () => {
            const url = req.url ?? '';
            const collMatch = url.match(/^\/collections\/([^/]+)$/);
            if (collMatch && req.method === 'GET') {
                const n = collMatch[1];
                if (state.collections.has(n)) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ result: { status: 'green' } }));
                }
                else {
                    res.writeHead(404);
                    res.end(JSON.stringify({ status: { error: 'missing' } }));
                }
                return;
            }
            if (collMatch && req.method === 'PUT' && !url.includes('/points')) {
                state.collections.set(collMatch[1], []);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ result: true }));
                return;
            }
            if (collMatch && req.method === 'DELETE') {
                state.collections.delete(collMatch[1]);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ result: true }));
                return;
            }
            if (url === '/collections' && req.method === 'GET') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    result: {
                        collections: Array.from(state.collections.keys()).map((n) => ({
                            name: n,
                        })),
                    },
                }));
                return;
            }
            const upsertMatch = url.match(/^\/collections\/([^/]+)\/points$/);
            if (upsertMatch && req.method === 'PUT') {
                const coll = state.collections.get(upsertMatch[1]);
                if (!coll) {
                    res.writeHead(404);
                    res.end();
                    return;
                }
                const data = JSON.parse(body);
                for (const p of data.points)
                    coll.push({ id: p.id, vector: p.vector, payload: p.payload });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ result: { status: 'completed' } }));
                return;
            }
            res.writeHead(404);
            res.end('Not found');
        });
    });
}
describe('QdrantRagProvider', () => {
    let server;
    let baseUrl;
    let state;
    before(async () => {
        state = { collections: new Map() };
        server = createStubServer(state);
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const addr = server.address();
        if (typeof addr === 'object' && addr)
            baseUrl = `http://127.0.0.1:${addr.port}`;
    });
    after(async () => {
        await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    });
    it('declares all three scopes as supported by default', () => {
        const p = new QdrantRagProvider({
            name: 'qdrant',
            url: baseUrl,
            embedder: makeEmbedder(),
        });
        assert.deepEqual([...p.supportedScopes].sort(), [
            'global',
            'session',
            'user',
        ]);
    });
    it('creates a QdrantRag targeting the collection name', async () => {
        const p = new QdrantRagProvider({
            name: 'qdrant',
            url: baseUrl,
            embedder: makeEmbedder(),
        });
        const res = await p.createCollection('test-a', { scope: 'global' });
        assert.ok(res.ok);
        assert.ok(res.value.rag instanceof QdrantRag);
    });
    it('rejects unsupported scope when supportedScopes is restricted', async () => {
        const p = new QdrantRagProvider({
            name: 'q',
            url: baseUrl,
            embedder: makeEmbedder(),
            supportedScopes: ['global'],
        });
        const res = await p.createCollection('x', {
            scope: 'session',
            sessionId: 'S',
        });
        assert.ok(!res.ok);
        assert.ok(res.error instanceof UnsupportedScopeError);
    });
    it('deleteCollection removes the Qdrant collection', async () => {
        state.collections.set('to-delete', []);
        const p = new QdrantRagProvider({
            name: 'q',
            url: baseUrl,
            embedder: makeEmbedder(),
        });
        const res = await p.deleteCollection?.('to-delete');
        assert.ok(res?.ok);
        assert.equal(state.collections.has('to-delete'), false);
    });
    it('listCollections returns collection names', async () => {
        state.collections.set('coll-a', []);
        state.collections.set('coll-b', []);
        const p = new QdrantRagProvider({
            name: 'q',
            url: baseUrl,
            embedder: makeEmbedder(),
        });
        const res = await p.listCollections?.();
        assert.ok(res?.ok);
        assert.ok(res.value.includes('coll-a'));
        assert.ok(res.value.includes('coll-b'));
    });
});
//# sourceMappingURL=qdrant-rag-provider.test.js.map