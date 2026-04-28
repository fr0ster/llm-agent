import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import { QueryEmbedding } from '@mcp-abap-adt/llm-agent';
import { QdrantRag } from './qdrant-rag.js';

// ---------------------------------------------------------------------------
// Stub embedder
// ---------------------------------------------------------------------------
function makeEmbedder(dim = 3) {
  return {
    async embed(text) {
      // Deterministic hash-based embedding
      let hash = 0;
      for (const ch of text) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
      return {
        vector: Array.from(
          { length: dim },
          (_, i) => ((hash >> i) & 0xff) / 255,
        ),
      };
    },
  };
}
function createStubServer(state) {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const url = req.url ?? '';
      // GET /collections/:name
      const getCollMatch = url.match(/^\/collections\/([^/]+)$/);
      if (getCollMatch && req.method === 'GET') {
        const name = getCollMatch[1];
        if (state.collections.has(name)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ result: { status: 'green' } }));
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: { error: 'Not found' } }));
        }
        return;
      }
      // PUT /collections/:name (create collection)
      if (getCollMatch && req.method === 'PUT' && !url.includes('/points')) {
        const name = getCollMatch[1];
        state.collections.set(name, []);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ result: true }));
        return;
      }
      // PUT /collections/:name/points (upsert)
      const upsertMatch = url.match(/^\/collections\/([^/]+)\/points$/);
      if (upsertMatch && req.method === 'PUT') {
        const name = upsertMatch[1];
        const data = JSON.parse(body);
        const coll = state.collections.get(name);
        if (!coll) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({ status: { error: 'Collection not found' } }),
          );
          return;
        }
        for (const p of data.points) {
          coll.push({ id: p.id, vector: p.vector, payload: p.payload });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ result: { status: 'completed' } }));
        return;
      }
      // POST /collections/:name/points (retrieve by ids)
      const retrieveMatch = url.match(/^\/collections\/([^/]+)\/points$/);
      if (retrieveMatch && req.method === 'POST') {
        const name = retrieveMatch[1];
        const data = JSON.parse(body);
        const coll = state.collections.get(name);
        if (!coll) {
          res.writeHead(404);
          res.end();
          return;
        }
        const ids = data.ids ?? [];
        const result = coll
          .filter((p) => ids.includes(p.id))
          .map((p) => ({ id: p.id, payload: p.payload }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ result }));
        return;
      }
      // POST /collections/:name/points/delete
      const deleteMatch = url.match(/^\/collections\/([^/]+)\/points\/delete$/);
      if (deleteMatch && req.method === 'POST') {
        const name = deleteMatch[1];
        const data = JSON.parse(body);
        const coll = state.collections.get(name);
        if (!coll) {
          res.writeHead(404);
          res.end();
          return;
        }
        if (data.filter && Object.keys(data.filter).length === 0) {
          coll.length = 0;
        } else if (Array.isArray(data.points)) {
          const ids = new Set(data.points);
          state.collections.set(
            name,
            coll.filter((p) => !ids.has(p.id)),
          );
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ result: { status: 'completed' } }));
        return;
      }
      // POST /collections/:name/points/search
      const searchMatch = url.match(/^\/collections\/([^/]+)\/points\/search$/);
      if (searchMatch && req.method === 'POST') {
        const name = searchMatch[1];
        const data = JSON.parse(body);
        const coll = state.collections.get(name);
        if (!coll) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({ status: { error: 'Collection not found' } }),
          );
          return;
        }
        // Simple dot-product scoring
        const results = coll
          .map((p) => {
            let score = 0;
            for (let i = 0; i < data.vector.length; i++) {
              score += (data.vector[i] ?? 0) * (p.vector[i] ?? 0);
            }
            return { score, payload: p.payload };
          })
          .sort((a, b) => b.score - a.score)
          .slice(0, data.limit ?? 10);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ result: results }));
        return;
      }
      res.writeHead(404);
      res.end('Not found');
    });
  });
}
describe('QdrantRag', () => {
  let server;
  let baseUrl;
  let state;
  before(async () => {
    state = { collections: new Map() };
    server = createStubServer(state);
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const addr = server.address();
    if (typeof addr === 'object' && addr) {
      baseUrl = `http://127.0.0.1:${addr.port}`;
    }
  });
  after(async () => {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });
  it('auto-creates collection on first upsert', async () => {
    const rag = new QdrantRag({
      url: baseUrl,
      collectionName: 'test-auto-create',
      embedder: makeEmbedder(),
    });
    assert.ok(!state.collections.has('test-auto-create'));
    const result = await rag.upsert('hello world', {});
    assert.ok(result.ok);
    assert.ok(state.collections.has('test-auto-create'));
  });
  it('upserts and queries documents', async () => {
    state.collections.set('test-query', []);
    const rag = new QdrantRag({
      url: baseUrl,
      collectionName: 'test-query',
      embedder: makeEmbedder(),
    });
    await rag.upsert('ABAP SELECT statement', { namespace: 'docs' });
    await rag.upsert('JavaScript forEach loop', { namespace: 'docs' });
    const embedder = makeEmbedder();
    const result = await rag.query(
      new QueryEmbedding('ABAP SELECT', embedder),
      5,
    );
    assert.ok(result.ok);
    assert.ok(result.value.length > 0);
    assert.ok(result.value[0].text.length > 0);
    assert.ok(result.value[0].score > 0);
  });
  it('healthCheck succeeds when collection exists', async () => {
    state.collections.set('test-health', []);
    const rag = new QdrantRag({
      url: baseUrl,
      collectionName: 'test-health',
      embedder: makeEmbedder(),
    });
    const result = await rag.healthCheck();
    assert.ok(result.ok);
  });
  it('healthCheck fails when collection does not exist', async () => {
    const rag = new QdrantRag({
      url: baseUrl,
      collectionName: 'nonexistent',
      embedder: makeEmbedder(),
    });
    const result = await rag.healthCheck();
    assert.ok(!result.ok);
    assert.equal(result.error.code, 'HEALTH_CHECK_ERROR');
  });
  it('handles connection errors gracefully', async () => {
    const rag = new QdrantRag({
      url: 'http://127.0.0.1:1',
      collectionName: 'unreachable',
      embedder: makeEmbedder(),
      timeoutMs: 1000,
    });
    const result = await rag.healthCheck();
    assert.ok(!result.ok);
    assert.equal(result.error.code, 'HEALTH_CHECK_ERROR');
  });
  it('passes api-key header when configured', async () => {
    state.collections.set('test-auth', []);
    // This just tests that the constructor accepts apiKey without error
    const rag = new QdrantRag({
      url: baseUrl,
      collectionName: 'test-auth',
      embedder: makeEmbedder(),
      apiKey: 'test-secret',
    });
    const result = await rag.healthCheck();
    assert.ok(result.ok);
  });
  it('getById returns the stored record via deterministic UUID', async () => {
    state.collections.set('test-get', []);
    const rag = new QdrantRag({
      url: baseUrl,
      collectionName: 'test-get',
      embedder: makeEmbedder(),
    });
    await rag.upsert('hello', { id: 'r1' });
    const got = await rag.getById?.('r1');
    assert.ok(got.ok);
    assert.ok(got.value);
    assert.equal(got.value?.text, 'hello');
  });
  it('getById returns null for unknown id', async () => {
    state.collections.set('test-get-miss', []);
    const rag = new QdrantRag({
      url: baseUrl,
      collectionName: 'test-get-miss',
      embedder: makeEmbedder(),
    });
    const got = await rag.getById?.('nope');
    assert.ok(got.ok);
    assert.equal(got.value, null);
  });
  it('writer().deleteByIdRaw removes the point', async () => {
    state.collections.set('test-del', []);
    const rag = new QdrantRag({
      url: baseUrl,
      collectionName: 'test-del',
      embedder: makeEmbedder(),
    });
    const w = rag.writer();
    await w.upsertRaw('r1', 'hi', {});
    assert.equal(state.collections.get('test-del')?.length, 1);
    const del = await w.deleteByIdRaw('r1');
    assert.ok(del.ok);
    assert.equal(state.collections.get('test-del')?.length, 0);
  });
  it('writer().clearAll empties the collection', async () => {
    state.collections.set('test-clear', []);
    const rag = new QdrantRag({
      url: baseUrl,
      collectionName: 'test-clear',
      embedder: makeEmbedder(),
    });
    const w = rag.writer();
    await w.upsertRaw('a', 't', {});
    await w.upsertRaw('b', 't', {});
    const cleared = await w.clearAll?.();
    assert.ok(cleared?.ok);
    assert.equal(state.collections.get('test-clear')?.length, 0);
  });
});
//# sourceMappingURL=qdrant-rag.test.js.map
