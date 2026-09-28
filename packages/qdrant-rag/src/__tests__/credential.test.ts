import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import type { IEmbedder } from '@mcp-abap-adt/llm-agent';
import { staticApiKey, symmetricEmbedder } from '@mcp-abap-adt/llm-agent';
import { QdrantRag } from '../qdrant-rag.js';

function makeEmbedder(dim = 3): IEmbedder {
  return {
    async embed(text: string) {
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

describe('QdrantRag credential', () => {
  let server: http.Server;
  let baseUrl: string;
  const receivedApiKeyHeaders: Array<string | undefined> = [];

  before(async () => {
    server = http.createServer((req, res) => {
      receivedApiKeyHeaders.push(req.headers['api-key'] as string | undefined);
      if (req.url?.match(/^\/collections\/[^/]+$/) && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ result: { status: 'green' } }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const addr = server.address();
    if (typeof addr === 'object' && addr) {
      baseUrl = `http://127.0.0.1:${addr.port}`;
    }
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it('asks the credential for the secret on every request, not once at construction', async () => {
    let calls = 0;
    const credential = {
      kind: 'api-key' as const,
      secret: async () => {
        calls++;
        return `key-${calls}`;
      },
    };
    const rag = new QdrantRag({
      url: baseUrl,
      collectionName: 'test-cred',
      embedder: symmetricEmbedder(makeEmbedder()),
      credential,
    });

    assert.equal(
      calls,
      0,
      'constructing the store must not resolve the secret',
    );

    const first = await rag.healthCheck();
    const second = await rag.healthCheck();

    assert.ok(first.ok);
    assert.ok(second.ok);
    assert.equal(calls, 2, 'the secret is asked once per request, not cached');
    assert.deepEqual(receivedApiKeyHeaders, ['key-1', 'key-2']);
  });

  it('sends the api-key header built from staticApiKey', async () => {
    receivedApiKeyHeaders.length = 0;
    const rag = new QdrantRag({
      url: baseUrl,
      collectionName: 'test-cred-static',
      embedder: symmetricEmbedder(makeEmbedder()),
      credential: staticApiKey('static-secret'),
    });
    const result = await rag.healthCheck();
    assert.ok(result.ok);
    assert.deepEqual(receivedApiKeyHeaders, ['static-secret']);
  });

  it('omits the api-key header when no credential is configured', async () => {
    receivedApiKeyHeaders.length = 0;
    const rag = new QdrantRag({
      url: baseUrl,
      collectionName: 'test-cred-none',
      embedder: symmetricEmbedder(makeEmbedder()),
    });
    const result = await rag.healthCheck();
    assert.ok(result.ok);
    assert.deepEqual(receivedApiKeyHeaders, [undefined]);
  });
});
