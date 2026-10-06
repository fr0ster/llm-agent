import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  asymmetricEmbedder,
  isBatchEmbedder,
  symmetricEmbedder,
  TextOnlyEmbedding,
} from '@mcp-abap-adt/llm-agent';
import { VectorRagProvider } from '../providers/vector-rag-provider.js';
import { VectorRag } from '../vector-rag.js';

/** Records which instance embedded which text. */
function recorder() {
  const seen: string[] = [];
  const embedder = (name: string) => ({
    embed: async (text: string) => {
      seen.push(`${name}:${text}`);
      return { vector: [1, 0] };
    },
  });
  return { seen, embedder };
}

describe('a store over an asymmetric retrieval embedder', () => {
  it('writes with the document half and embeds its own search text with the query half', async () => {
    const r = recorder();
    const rag = new VectorRag(
      asymmetricEmbedder({
        document: r.embedder('document'),
        query: r.embedder('query'),
      }),
    );
    await rag.upsert('stored text', { id: '1' });
    // A text-only query (a sub-agent's, for one) makes the store embed it.
    await rag.query(new TextOnlyEmbedding('search text'), 1);
    assert.deepEqual(r.seen, ['document:stored text', 'query:search text']);
  });

  it('a collection provider hands the retrieval embedder to its stores', async () => {
    const r = recorder();
    const provider = new VectorRagProvider({
      name: 'p',
      embedder: asymmetricEmbedder({
        document: r.embedder('document'),
        query: r.embedder('query'),
      }),
    });
    const created = await provider.createCollection('c', {
      scope: 'session',
      sessionId: 's',
    });
    assert.ok(created.ok);
    await created.value.rag.upsert('stored text', { id: '1' });
    await created.value.rag.query(new TextOnlyEmbedding('search text'), 1);
    assert.deepEqual(r.seen, ['document:stored text', 'query:search text']);
  });
});

describe('symmetricEmbedder', () => {
  it('sends both jobs to the one embedder', async () => {
    const r = recorder();
    const e = symmetricEmbedder(r.embedder('one'));
    await e.embedDocument('d');
    await e.embedQuery('q');
    assert.deepEqual(r.seen, ['one:d', 'one:q']);
  });

  it('offers embedDocuments only when the embedder batches', async () => {
    const plain = { embed: async () => ({ vector: [1] }) };
    const batching = {
      embed: async () => ({ vector: [1] }),
      embedBatch: async (texts: string[]) => texts.map(() => ({ vector: [2] })),
    };
    assert.ok(isBatchEmbedder(batching));
    assert.equal(symmetricEmbedder(plain).embedDocuments, undefined);
    assert.deepEqual(
      await symmetricEmbedder(batching).embedDocuments?.(['a', 'b']),
      [{ vector: [2] }, { vector: [2] }],
    );
  });
});
