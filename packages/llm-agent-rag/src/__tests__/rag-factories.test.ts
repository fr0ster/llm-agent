import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  asymmetricEmbedder,
  MissingProviderError,
  symmetricEmbedder,
  TextOnlyEmbedding,
} from '@mcp-abap-adt/llm-agent';
import { _resetPrefetchedForTests } from '../embedder-factories.js';
import { makeRag, prefetchRagFactories } from '../rag-factories.js';

// `resolveRag`, `RagFactoryOpts` and `_resetPrefetchedRagForTests` are gone
// (task B6b): `resolveRag` had no consumer outside this package once
// `makeRag` dispatched over literal import specifiers directly, and there is
// no module cache left for `_resetPrefetchedRagForTests` to clear — every
// call, in `prefetchRagFactories` and in `makeRag` alike, imports through
// its own literal specifier, and the ES module loader's cache is what makes
// repeating that free. The two tests that only existed to exercise
// `resolveRag`'s prefetch-then-resolve split are deleted with it; what they
// covered (a credential's kind checked before a constructor runs) is now a
// compile-time property of `RagResolution`, asserted in
// `../__typechecks__/rag-resolution.ts`, not a runtime path to test here.

const stubEmbedder = symmetricEmbedder({
  async embed() {
    return { vector: [0] };
  },
  async embedBatch(texts: string[]) {
    return texts.map(() => ({ vector: [0] }));
  },
});

describe('rag-factories', () => {
  it('throws MissingProviderError for unknown backend name', async () => {
    await assert.rejects(
      () => prefetchRagFactories(['nope']),
      MissingProviderError,
    );
  });

  it('makeRag qdrant imports its peer on demand (no MissingProviderError)', async () => {
    // No prior prefetchRagFactories call: makeRag's own literal import must
    // succeed on its own — qdrant-rag is a workspace dev dependency, so this
    // is a real, live import, not a stand-in.
    // Actual Qdrant connection failure is fine; this test only guards
    // against a missing-provider regression.
    try {
      const rag = await makeRag({
        type: 'qdrant',
        url: 'http://localhost:6333',
        collectionName: 'test',
        embedder: symmetricEmbedder(stubEmbedder),
      });
      assert.equal(typeof rag.query, 'function');
    } catch (err) {
      assert.ok(
        !(err instanceof MissingProviderError),
        `Expected no MissingProviderError but got: ${err}`,
      );
    }
  });

  it('makeRag in-memory builds a real VectorRag from an already-built embedder', async () => {
    // Embedder-BY-NAME resolution ('openai', a credential, a model string)
    // is resolveEmbedder's job now, called by the caller BEFORE makeRag —
    // RagResolution.embedder is always an already-built IEmbedder. This
    // replaces the old test that resolved 'openai' by name inside makeRag,
    // which is no longer a thing makeRag does at all.
    _resetPrefetchedForTests();
    const rag = await makeRag({
      type: 'in-memory',
      embedder: symmetricEmbedder(stubEmbedder),
      collectionName: 'my-namespace',
    });
    assert.ok(
      rag,
      'an in-memory RAG must be constructible from a built embedder',
    );
  });

  it('makeRag unknown type throws a clear error (not MissingProviderError)', async () => {
    await assert.rejects(
      // biome-ignore lint/suspicious/noExplicitAny: intentional invalid type for test
      () => makeRag({ type: 'ollama' } as any),
      /Unknown rag\.type.*Use one of/,
    );
  });
});

describe('makeRag — an asymmetric retrieval embedder', () => {
  it('the store writes with the document half and embeds its own search text with the query half', async () => {
    const seen: string[] = [];
    const half = (role: string) => ({
      embed: async (text: string) => {
        seen.push(`${role}:${text}`);
        return { vector: [1, 0] };
      },
    });
    const rag = await makeRag({
      type: 'in-memory',
      embedder: asymmetricEmbedder({
        document: half('document'),
        query: half('query'),
      }),
    });
    await rag.upsert('stored text', { id: '1' });
    await rag.query(new TextOnlyEmbedding('search text'), 1);
    assert.deepEqual(seen, ['document:stored text', 'query:search text']);
  });
});
