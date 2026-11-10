import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { symmetricEmbedder, TextOnlyEmbedding } from '@mcp-abap-adt/llm-agent';
import {
  conformanceEmbedder,
  ragFilterConformanceCases,
  ragOwnerFilterConformanceCases,
  ragRawOwnerConformanceCase,
} from '@mcp-abap-adt/llm-agent/testing/rag-filter-conformance';
import { QdrantRag } from '../qdrant-rag.js';
import { type QdrantStub, startQdrantStub } from './qdrant-stub.js';

// The shared conformance kit over QdrantRag, against a stub that evaluates the
// search filter with Qdrant's documented semantics. The same cases run live
// against a real Qdrant in the release check.
describe('QdrantRag — filter conformance (stub)', () => {
  let stub: QdrantStub;
  let n = 0;
  before(async () => {
    stub = await startQdrantStub();
  });
  after(async () => {
    await stub.close();
  });

  for (const c of [
    ...ragFilterConformanceCases,
    ...ragOwnerFilterConformanceCases,
  ]) {
    it(c.name, () =>
      c.run(
        async () =>
          new QdrantRag({
            url: stub.baseUrl,
            collectionName: `conf_${n++}`,
            embedder: symmetricEmbedder(conformanceEmbedder()),
          }),
      ),
    );
  }

  it('raw records without ownerScope and with scope/id mismatch never match an owner query', async () => {
    const collectionName = `conf_${n++}`;
    stub.collections.set(collectionName, {
      size: 64,
      points: new Map([
        [
          'legacy',
          {
            id: 'legacy',
            vector: new Array<number>(64).fill(1),
            payload: { sessionId: 's' },
          },
        ],
        [
          'mismatch',
          {
            id: 'mismatch',
            vector: new Array<number>(64).fill(1),
            payload: { ownerScope: 'user', sessionId: 's' },
          },
        ],
      ]),
    });
    const rag = new QdrantRag({
      url: stub.baseUrl,
      collectionName,
      embedder: symmetricEmbedder(conformanceEmbedder()),
    });
    for (const owner of [
      { scope: 'session', sessionId: 's' },
      { scope: 'user', userId: 'u' },
      { scope: 'role', roleId: 'r' },
      { scope: 'global' },
    ] as const) {
      const result = await rag.query(new TextOnlyEmbedding('query'), 10, {
        ragFilter: { owner },
      });
      assert.ok(result.ok);
      assert.deepEqual(result.value, []);
    }
  });

  it('global filters exclude even null and empty-array owner keys before top-k', async () => {
    const collectionName = `conf_${n++}`;
    const rag = new QdrantRag({
      url: stub.baseUrl,
      collectionName,
      embedder: symmetricEmbedder(conformanceEmbedder()),
    });
    for (const key of ['sessionId', 'userId', 'roleId']) {
      for (const value of [null, []]) {
        assert.equal(
          (
            await rag.upsert('quarterly revenue forecast', {
              id: `${key}_${JSON.stringify(value)}`,
              [key]: value,
            })
          ).ok,
          false,
        );
      }
    }
    assert.ok((await rag.upsert('lima penguin iceberg', { id: 'global' })).ok);
    const result = await rag.query(
      new TextOnlyEmbedding('quarterly revenue forecast'),
      1,
      { ragFilter: { owner: { scope: 'global' } } },
    );
    assert.ok(result.ok);
    assert.deepEqual(
      result.value.map((hit) => hit.metadata.id),
      ['global'],
    );
    const request = [...stub.requests]
      .reverse()
      .find((request) => request.path.endsWith('/points/search'));
    assert.ok(request);
    assert.match(JSON.stringify(request.body), /ownerScope/);
    assert.match(JSON.stringify(request.body), /global/);
  });

  it('global queries work without an exact-version gate', async () => {
    const rag = new QdrantRag({
      url: stub.baseUrl,
      collectionName: `conf_${n++}`,
      embedder: symmetricEmbedder(conformanceEmbedder()),
    });
    assert.ok((await rag.upsert('query', { id: 'g' })).ok);
    stub.version = '1.19.0';
    try {
      const searches = stub.requests.filter((request) =>
        request.path.endsWith('/points/search'),
      ).length;
      assert.equal(
        (
          await rag.query(new TextOnlyEmbedding('query'), 1, {
            ragFilter: { owner: { scope: 'global' } },
          })
        ).ok,
        true,
      );
      assert.equal(
        stub.requests.filter((request) =>
          request.path.endsWith('/points/search'),
        ).length,
        searches + 1,
      );
    } finally {
      stub.version = '1.17.0';
    }
  });
});

it('Qdrant shared raw conflicting-owner records are excluded and writes refused', async () => {
  const stub = await startQdrantStub();
  try {
    const points = new Map<string, import('./qdrant-stub.js').StubPoint>();
    stub.collections.set('raw', { size: 64, points });
    const rag = new QdrantRag({
      url: stub.baseUrl,
      collectionName: 'raw',
      embedder: symmetricEmbedder(conformanceEmbedder()),
    });
    await ragRawOwnerConformanceCase({
      rag,
      async insertRaw(r) {
        points.set(r.id, {
          id: r.id,
          vector: (await conformanceEmbedder().embed(r.text)).vector,
          payload: { ...r.metadata, id: r.id, text: r.text },
        });
      },
    });
  } finally {
    await stub.close();
  }
});
