import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MissingProviderError, staticApiKey } from '@mcp-abap-adt/llm-agent';
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
        model: 'bge-m3',
      });
    } catch (err) {
      assert.ok(
        !(err instanceof MissingProviderError),
        `Expected no MissingProviderError but got: ${err}`,
      );
    }
  });

  it('makeRag in-memory+openai embedder auto-prefetches without prior prefetch (no MissingProviderError)', async () => {
    _resetPrefetchedRagForTests();
    _resetPrefetchedForTests();
    try {
      // resolveEmbedder now declares `credential` on EmbedderResolutionConfig
      // and forwards it (and `apiBaseUrl`) instead of a hand-picked whitelist,
      // so this credential reaches OpenAiEmbedder's constructor for real.
      const rag = await makeRag({
        type: 'in-memory',
        embedder: 'openai',
        credential: staticApiKey('test'),
        model: 'text-embedding-3-small',
      });
      // Assert on the HAPPY path too: everything below runs only if something
      // throws, so without this the case proves nothing when the bridge works —
      // and it was skipped precisely because it passed while proving nothing.
      assert.ok(
        rag,
        'an in-memory RAG with an openai embedder must be constructible',
      );
    } catch (err) {
      // Narrow on purpose: a network failure reaching OpenAI is acceptable here,
      // failing to CONSTRUCT the embedder is the regression this test exists for,
      // and the previous blanket check swallowed exactly that.
      assert.ok(
        !(err instanceof MissingProviderError),
        `Expected no MissingProviderError but got: ${err}`,
      );
      assert.doesNotMatch(
        String(err),
        /API key is required|requires a 'credential'/,
        `The embedder could not be built at all: ${err}`,
      );
    }
  });

  it('makeRag unknown type throws a clear error (not MissingProviderError)', async () => {
    await assert.rejects(
      // biome-ignore lint/suspicious/noExplicitAny: intentional invalid type for test
      () => makeRag({ type: 'ollama' as any }),
      /Unknown rag\.type.*Use one of/,
    );
  });
});
