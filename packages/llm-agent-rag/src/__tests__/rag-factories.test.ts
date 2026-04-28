import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MissingProviderError } from '@mcp-abap-adt/llm-agent';
import { _resetPrefetchedForTests } from '../embedder-factories.js';
import {
  _resetPrefetchedRagForTests,
  makeRag,
  prefetchRagFactories,
  resolveRag,
} from '../rag-factories.js';

describe('rag-factories', () => {
  it('throws MissingProviderError for unknown backend name', async () => {
    _resetPrefetchedRagForTests();
    await assert.rejects(
      () => prefetchRagFactories(['nope']),
      MissingProviderError,
    );
  });

  it('throws MissingProviderError at resolveRag when not prefetched', () => {
    _resetPrefetchedRagForTests();
    assert.throws(
      () =>
        resolveRag('hana-vector', {
          collectionName: 'x',
          embedder: {
            async embed() {
              return { vector: [0] };
            },
          },
        }),
      MissingProviderError,
    );
  });

  it('prefetches known packages (qdrant already a workspace dev dep)', async () => {
    _resetPrefetchedRagForTests();
    await prefetchRagFactories(['qdrant']);
    const rag = resolveRag('qdrant', {
      url: 'http://localhost:6333',
      collectionName: 't',
      embedder: {
        async embed() {
          return { vector: [0, 0, 0] };
        },
      },
    });
    assert.equal(typeof rag.query, 'function');
  });

  it('makeRag qdrant auto-prefetches without prior prefetch (no MissingProviderError)', async () => {
    _resetPrefetchedRagForTests();
    _resetPrefetchedForTests();
    // Verify it does NOT throw MissingProviderError — actual Qdrant connection
    // failure is fine; the test only guards against missing-provider regression.
    try {
      await makeRag({
        type: 'qdrant',
        url: 'http://localhost:6333',
        collectionName: 'test',
        embedder: 'ollama',
      });
    } catch (err) {
      assert.ok(
        !(err instanceof MissingProviderError),
        `Expected no MissingProviderError but got: ${err}`,
      );
    }
  });

  it('makeRag openai auto-prefetches embedder without prior prefetch (no MissingProviderError)', async () => {
    _resetPrefetchedRagForTests();
    _resetPrefetchedForTests();
    // Verify it does NOT throw MissingProviderError — actual OpenAI network
    // failure is fine; the test only guards against missing-provider regression.
    try {
      await makeRag({ type: 'openai', apiKey: 'test' });
    } catch (err) {
      assert.ok(
        !(err instanceof MissingProviderError),
        `Expected no MissingProviderError but got: ${err}`,
      );
    }
  });

  it('makeRag default path with explicit openai embedder auto-prefetches (no MissingProviderError)', async () => {
    _resetPrefetchedRagForTests();
    _resetPrefetchedForTests();
    // Verify it does NOT throw MissingProviderError — actual OpenAI network
    // failure is fine; the test only guards against missing-provider regression.
    try {
      await makeRag({ embedder: 'openai', apiKey: 'test' });
    } catch (err) {
      assert.ok(
        !(err instanceof MissingProviderError),
        `Expected no MissingProviderError but got: ${err}`,
      );
    }
  });
});
