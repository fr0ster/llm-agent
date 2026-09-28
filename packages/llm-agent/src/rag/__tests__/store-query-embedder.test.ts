import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { VectorRagProvider } from '../providers/vector-rag-provider.js';
import { TextOnlyEmbedding } from '../query-embedding.js';
import { storeEmbedders } from '../store-embedders.js';
import { VectorRag } from '../vector-rag.js';

/** Records which half embedded which text. */
function halves() {
  const seen: string[] = [];
  const half = (role: string) => ({
    embed: async (text: string) => {
      seen.push(`${role}:${text}`);
      return { vector: [1, 0] };
    },
  });
  return { seen, document: half('document'), query: half('query') };
}

describe('a store with an asymmetric pair', () => {
  it('writes with the document half and embeds its own search text with the query half', async () => {
    const h = halves();
    const rag = new VectorRag(h.document, { queryEmbedder: h.query });
    await rag.upsert('stored text', { id: '1' });
    // A text-only query (a worker's, for one) makes the store embed it itself.
    await rag.query(new TextOnlyEmbedding('search text'), 1);
    assert.deepEqual(h.seen, ['document:stored text', 'query:search text']);
  });

  it('with one symmetric embedder, that one does both, as before', async () => {
    const h = halves();
    const rag = new VectorRag(h.document);
    await rag.upsert('stored text', { id: '1' });
    await rag.query(new TextOnlyEmbedding('search text'), 1);
    assert.deepEqual(h.seen, ['document:stored text', 'document:search text']);
  });
});

describe('storeEmbedders', () => {
  it('is the pair when a query half is given, the embedder alone when not', () => {
    const h = halves();
    assert.deepEqual(storeEmbedders(h.document, h.query), {
      embedder: h.document,
      queryEmbedder: h.query,
    });
    assert.deepEqual(storeEmbedders(h.document), { embedder: h.document });
  });
});

describe('VectorRagProvider with a query half', () => {
  it('hands the pair to the stores it creates', async () => {
    const h = halves();
    const provider = new VectorRagProvider({
      name: 'p',
      embedder: h.document,
      queryEmbedder: h.query,
    });
    const created = await provider.createCollection('c', {
      scope: 'session',
      sessionId: 's',
    });
    assert.ok(created.ok);
    await created.value.rag.upsert('stored text', { id: '1' });
    await created.value.rag.query(new TextOnlyEmbedding('search text'), 1);
    assert.deepEqual(h.seen, ['document:stored text', 'query:search text']);
  });
});
