import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IRetrievalEmbedder } from '@mcp-abap-adt/llm-agent';
import {
  MODEL_CONTEXT_EXCEEDED,
  QueryEmbedding,
  RagError,
  staticLogin,
  TextOnlyEmbedding,
} from '@mcp-abap-adt/llm-agent';
import { HanaVectorRag } from '../hana-vector-rag.js';

function makeRag(
  embedder: IRetrievalEmbedder,
  fallbackOnQueryEmbeddingError: boolean | undefined,
): HanaVectorRag {
  return new HanaVectorRag(
    {
      collectionName: 'docs',
      dimension: 3,
      autoCreateSchema: false,
      credential: staticLogin('user', 'password'),
      embedder,
      fallbackOnQueryEmbeddingError,
    },
    {
      exec: async () => ({ rowCount: 0 }),
      query: async () => [],
      close: async () => {},
    },
  );
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

describe('HanaVectorRag query embedding fallback policy', () => {
  for (const operation of ['query', 'upsert']) {
    it(`${operation} preserves embedding overflow when the signal is also aborted`, async () => {
      const abort = new AbortController();
      const overflow = new RagError(
        'Embedding input too long',
        MODEL_CONTEXT_EXCEEDED,
      );
      const fail = async () => {
        abort.abort();
        throw overflow;
      };
      const embedder = { embedQuery: fail, embedDocument: fail };
      const rag = makeRag(embedder, true);
      const options = { signal: abort.signal };
      const result =
        operation === 'query'
          ? await rag.query(new QueryEmbedding('query', embedder), 1, options)
          : await rag.upsert('document', { id: 'doc' }, options);
      assert.deepEqual(result, { ok: false, error: overflow });
    });
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

    it(`handles a first rejection when the second call would succeed (fallback=${policy})`, async () => {
      const failure = new RagError(
        'First query embedding failed',
        'EMBED_ERROR',
      );
      const { embedder, calls } = makeEmbedder(failure);
      const rag = makeRag(embedder, fallbackOnQueryEmbeddingError);
      const result = await rag.query(new QueryEmbedding('query', embedder), 1);

      if (fallbackOnQueryEmbeddingError === false) {
        assert.equal(result.ok, false);
        if (result.ok) assert.fail('Expected the first embedding failure');
        assert.equal(result.error, failure);
        assert.deepEqual(calls, ['query']);
      } else {
        assert.ok(result.ok);
        assert.deepEqual(calls, ['query', 'query']);
      }
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
        if (!result.ok) {
          if (fallbackOnQueryEmbeddingError === false) {
            assert.equal(result.error, failure);
          } else {
            assert.equal(result.error.code, 'QUERY_ERROR');
            assert.match(result.error.message, /Text-only embedding failed/);
          }
        }
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
    assert.equal(result.error.code, 'QUERY_ERROR');
    assert.match(result.error.message, /Original query embedding failure/);
    assert.deepEqual(calls, ['query']);
  });
});
