import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { MissingProviderError } from '@mcp-abap-adt/llm-agent';
import { makeRag } from '../providers.js';
import {
  _resetPrefetchedRagForTests,
  prefetchRagFactories,
  resolveRag,
} from '../rag-factories.js';

/**
 * HanaVectorRag and PgVectorRag eagerly create a `clientPromise` in their
 * constructor that tries to import the native driver at module-load time. In a
 * test environment those drivers are absent (or shaped differently), so the
 * promise will always reject. We only verify the *sync shape* of the instance
 * (i.e. that `ensureSchema` is a function), so we suppress these expected
 * background rejections for the whole describe block.
 */
function suppressDriverInitErrors(_reason: unknown) {
  /* intentionally absorbed — background driver-init failure is expected */
}

describe('hana-vector / pg-vector server integration', () => {
  before(() => {
    process.on('unhandledRejection', suppressDriverInitErrors);
  });

  after(() => {
    process.off('unhandledRejection', suppressDriverInitErrors);
  });

  it('resolveRag throws MissingProviderError when peer is not prefetched', () => {
    _resetPrefetchedRagForTests();
    assert.throws(
      () =>
        resolveRag('hana-vector', {
          collectionName: 't',
          host: 'h',
          user: 'u',
          password: 'p',
          embedder: {
            async embed() {
              return { vector: [0] };
            },
          },
        }),
      MissingProviderError,
    );
  });

  it('makeRag path exposes ensureSchema() for hana-vector (direct construction)', async () => {
    _resetPrefetchedRagForTests();
    await prefetchRagFactories(['hana-vector']);
    const embedder = {
      async embed() {
        return { vector: [0, 0, 0] };
      },
    };
    const rag = makeRag(
      {
        type: 'hana-vector',
        host: 'h',
        user: 'u',
        password: 'p',
        collectionName: 'direct_docs',
        dimension: 3,
        autoCreateSchema: true,
      },
      { injectedEmbedder: embedder },
    ) as unknown as { ensureSchema: () => Promise<void> };
    assert.equal(typeof rag.ensureSchema, 'function');
  });

  it('makeRag path exposes ensureSchema() for pg-vector (direct construction)', async () => {
    _resetPrefetchedRagForTests();
    await prefetchRagFactories(['pg-vector']);
    const embedder = {
      async embed() {
        return { vector: [0, 0, 0] };
      },
    };
    const rag = makeRag(
      {
        type: 'pg-vector',
        host: 'h',
        user: 'u',
        password: 'p',
        database: 'd',
        collectionName: 'direct_docs',
        dimension: 3,
        autoCreateSchema: true,
      },
      { injectedEmbedder: embedder },
    ) as unknown as { ensureSchema: () => Promise<void> };
    assert.equal(typeof rag.ensureSchema, 'function');
  });
});
