import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IEmbedder } from '../../interfaces/rag.js';
import { RagError } from '../../interfaces/types.js';
import {
  FallbackQueryEmbedding,
  QueryEmbedding,
  TextOnlyEmbedding,
} from '../query-embedding.js';
import { symmetricEmbedder } from '../retrieval-embedder.js';

function countingEmbedder(
  vector: number[],
): IEmbedder & { readonly calls: number } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async embed() {
      calls++;
      return { vector };
    },
  };
}

describe('FallbackQueryEmbedding — store embedder only for a text-only embedding (R1, D73)', () => {
  it('a TextOnlyEmbedding is embedded by the store embedder', async () => {
    const store = countingEmbedder([7, 8, 9]);
    const fqe = new FallbackQueryEmbedding(
      new TextOnlyEmbedding('q'),
      symmetricEmbedder(store),
    );
    assert.deepEqual(await fqe.toVector(), [7, 8, 9]);
    assert.equal(store.calls, 1);
  });

  it('a failing real embedding rejects with its error; the store embedder is not called', async () => {
    const broken: IEmbedder = {
      async embed() {
        throw new RagError('down', 'CIRCUIT_OPEN');
      },
    };
    const store = countingEmbedder([7, 8, 9]);
    const fqe = new FallbackQueryEmbedding(
      new QueryEmbedding('q', symmetricEmbedder(broken)),
      symmetricEmbedder(store),
    );
    await assert.rejects(fqe.toVector(), (e: unknown) => {
      assert.ok(e instanceof RagError);
      assert.equal(e.code, 'CIRCUIT_OPEN');
      assert.equal(e.message, 'down');
      return true;
    });
    assert.equal(store.calls, 0);
  });
});
