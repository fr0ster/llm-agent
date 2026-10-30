import assert from 'node:assert/strict';
import { after, before, describe, it, mock } from 'node:test';
import { symmetricEmbedder } from '@mcp-abap-adt/llm-agent';
import { conformanceEmbedder } from '@mcp-abap-adt/llm-agent/testing/rag-filter-conformance';
import { ragListConformanceCases } from '@mcp-abap-adt/llm-agent/testing/rag-list-conformance';
import { QdrantRag } from '../qdrant-rag.js';
import { type QdrantStub, startQdrantStub } from './qdrant-stub.js';

let stub: QdrantStub;
let sequence = 0;
before(async () => {
  stub = await startQdrantStub();
});
after(async () => {
  await stub.close();
});
describe('Qdrant listing conformance (stub)', () => {
  for (const test of ragListConformanceCases)
    it(test.name, () =>
      test.run(async () => {
        const collectionName = `listing_${sequence++}`;
        const response = await fetch(
          `${stub.baseUrl}/collections/${collectionName}`,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ vectors: { size: 64, distance: 'Cosine' } }),
          },
        );
        if (!response.ok) throw new Error('Failed to create collection');
        return new QdrantRag({
          url: stub.baseUrl,
          collectionName,
          embedder: symmetricEmbedder(conformanceEmbedder()),
        });
      }),
    );
});

it('listing reports backend failures and suppresses late success after cancellation', async () => {
  const store = new QdrantRag({
    url: stub.baseUrl,
    collectionName: 'listing_failure',
    embedder: symmetricEmbedder(conformanceEmbedder()),
  });
  for (const response of [
    Response.json({}, { status: 500 }),
    Response.json({}),
    Response.json({ result: { points: [], next_page_offset: 'bad' } }),
  ]) {
    const replacement = mock.method(globalThis, 'fetch', async () => response);
    try {
      const result = await store.list();
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, 'QUERY_ERROR');
    } finally {
      replacement.mock.restore();
    }
  }
  const controller = new AbortController();
  const replacement = mock.method(globalThis, 'fetch', async () => {
    controller.abort();
    return Response.json({ result: { points: [], next_page_offset: null } });
  });
  try {
    const result = await store.list({}, { signal: controller.signal });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'ABORTED');
  } finally {
    replacement.mock.restore();
  }
});

it('listing rejects malformed stored metadata and requests no vectors', async () => {
  const collectionName = 'listing_metadata';
  stub.collections.set(collectionName, {
    size: 64,
    points: new Map([
      [
        '00000000-0000-0000-0000-000000000001',
        {
          id: '00000000-0000-0000-0000-000000000001',
          vector: [1],
          payload: { text: 'text', id: 17 },
        },
      ],
    ]),
  });
  const store = new QdrantRag({
    url: stub.baseUrl,
    collectionName,
    embedder: symmetricEmbedder(conformanceEmbedder()),
  });
  const result = await store.list();
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'RAG_INVALID_METADATA');
  const request = [...stub.requests]
    .reverse()
    .find(
      (entry) =>
        entry.path.includes(collectionName) && entry.path.endsWith('/scroll'),
    );
  assert.ok(request);
  assert.match(JSON.stringify(request.body), /"with_vector":false/);
});

it('strict client filtering preserves continuation on an empty page', async () => {
  const collectionName = 'listing_short';
  const first = '00000000-0000-0000-0000-000000000001';
  const second = '00000000-0000-0000-0000-000000000002';
  stub.collections.set(collectionName, {
    size: 64,
    points: new Map([
      [
        first,
        { id: first, vector: [1], payload: { id: 'array', userId: ['owner'] } },
      ],
      [
        second,
        { id: second, vector: [1], payload: { id: 'owned', userId: 'owner' } },
      ],
    ]),
  });
  const store = new QdrantRag({
    url: stub.baseUrl,
    collectionName,
    embedder: symmetricEmbedder(conformanceEmbedder()),
  });
  const initial = await store.list({ limit: 1, filter: { userId: 'owner' } });
  assert.ok(initial.ok);
  assert.deepEqual(initial.value.records, []);
  assert.ok(initial.value.cursor);
  const next = await store.list({
    cursor: initial.value.cursor,
    limit: 1,
    filter: { userId: 'owner' },
  });
  assert.ok(next.ok);
  assert.deepEqual(
    next.value.records.map((record) => record.id),
    ['owned'],
  );
});
