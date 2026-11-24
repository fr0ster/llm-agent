import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IRetrievalEmbedder } from '../../interfaces/rag.js';
import { RagError } from '../../interfaces/types.js';
import { QueryEmbedding, TextOnlyEmbedding } from '../query-embedding.js';
import { VectorRag } from '../vector-rag.js';

function makeRag(
  embedder: IRetrievalEmbedder,
  fallbackOnQueryEmbeddingError: boolean | undefined,
): VectorRag {
  return new VectorRag(embedder, { fallbackOnQueryEmbeddingError });
}

function makeEmbedder(firstFailure?: Error) {
  const calls: string[] = [];
  const embedder: IRetrievalEmbedder = {
    embedDocument: async () => {
      assert.fail('Querying must not embed a document');
    },
    embedQuery: async (text) => {
      calls.push(text);
      if (calls.length === 1 && firstFailure) throw firstFailure;
      return { vector: [1, 0, 0] };
    },
  };
  return { embedder, calls };
}

describe('VectorRag query embedding fallback policy', () => {
  for (const fallbackOnQueryEmbeddingError of [undefined, true, false]) {
    for (const fail of [false, true]) {
      it(`embeds transformed text once (fallback=${String(fallbackOnQueryEmbeddingError)}, fail=${fail})`, async () => {
        const failure = new RagError(
          'Transformed embedding failed',
          'EMBED_ERROR',
        );
        const { embedder, calls } = makeEmbedder(fail ? failure : undefined);
        let callerCalls = 0;
        const rag = new VectorRag(embedder, {
          fallbackOnQueryEmbeddingError,
          queryPreprocessors: [
            {
              name: 'transform',
              process: async () => ({ ok: true, value: 'transformed query' }),
            },
          ],
        });
        const result = await rag.query(
          {
            text: 'query',
            toVector: async () => {
              callerCalls++;
              return [0, 1, 0];
            },
          },
          1,
        );

        assert.equal(callerCalls, 0);
        assert.deepEqual(calls, ['transformed query']);
        assert.equal(result.ok, !fail);
        if (!result.ok) assert.equal(result.error, failure);
      });
    }
  }

  for (const fallbackOnQueryEmbeddingError of [undefined, true, false]) {
    const policy = String(fallbackOnQueryEmbeddingError);

    it(`preserves a supplied vector (fallback=${policy})`, async () => {
      const { embedder, calls } = makeEmbedder();
      const rag = makeRag(embedder, fallbackOnQueryEmbeddingError);
      const result = await rag.query(new QueryEmbedding('query', embedder), 1);

      assert.ok(result.ok);
      assert.deepEqual(calls, ['query']);
    });

    it(`returns the first rejection even when a second call would succeed (fallback=${policy})`, async () => {
      const failure = new RagError(
        'First query embedding failed',
        'EMBED_ERROR',
      );
      const { embedder, calls } = makeEmbedder(failure);
      const rag = makeRag(embedder, fallbackOnQueryEmbeddingError);
      const result = await rag.query(new QueryEmbedding('query', embedder), 1);

      assert.equal(result.ok, false);
      if (result.ok) assert.fail('Expected the first embedding failure');
      assert.equal(result.error, failure);
      assert.deepEqual(calls, ['query']);
    });

    for (const fail of [false, true]) {
      it(`embeds text-only queries once and propagates errors (fallback=${policy}, fail=${fail})`, async () => {
        const failure = new RagError(
          'Text-only embedding failed',
          'EMBED_ERROR',
        );
        const { embedder, calls } = makeEmbedder(fail ? failure : undefined);
        const rag = makeRag(embedder, fallbackOnQueryEmbeddingError);
        const result = await rag.query(new TextOnlyEmbedding('query'), 1);

        assert.deepEqual(calls, ['query']);
        assert.equal(result.ok, !fail);
        if (!result.ok) assert.equal(result.error, failure);
      });
    }
  }

  it('returns an ordinary embedding rejection as a Result error without retrying', async () => {
    const failure = new Error('Original query embedding failure');
    const { embedder, calls } = makeEmbedder(failure);
    const rag = makeRag(embedder, false);
    const result = await rag.query(new QueryEmbedding('query', embedder), 1);

    assert.equal(result.ok, false);
    if (result.ok) assert.fail('Expected a failed Result');
    assert.equal(result.error.code, 'EMBED_ERROR');
    assert.equal(result.error.cause, failure);
    assert.deepEqual(calls, ['query']);
  });
});
