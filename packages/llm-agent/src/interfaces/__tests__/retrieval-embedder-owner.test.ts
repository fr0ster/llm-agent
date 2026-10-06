import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { symmetricEmbedder } from '../../rag/retrieval-embedder.js';
import type { IRag } from '../rag.js';
import { retrievalEmbedderOf } from '../retrieval-embedder-owner.js';

const embedder = symmetricEmbedder({ embed: async () => ({ vector: [1, 0] }) });
/** A bare store: no embedder, no decorator. */
const plain = (): IRag =>
  ({
    query: async () => ({ ok: true, value: [] }),
    healthCheck: async () => ({ ok: true, value: undefined }),
    getById: async () => ({ ok: true, value: null }),
  }) as unknown as IRag;
/** A store that owns an embedder (what VectorRag and the provider stores declare). */
const owner = (): IRag =>
  Object.assign(plain(), { retrievalEmbedder: embedder });
const decorate = (inner: IRag): IRag =>
  ({
    inner,
    query: (q: never, k: never, o: never) => inner.query(q, k, o),
    healthCheck: (o: never) => inner.healthCheck(o),
    getById: (id: never, o: never) => inner.getById(id, o),
  }) as unknown as IRag;

describe('retrievalEmbedderOf', () => {
  it('an owner exposes its embedder', () => {
    assert.equal(retrievalEmbedderOf(owner()), embedder);
  });
  it('walks decorators to the owner', () => {
    assert.equal(retrievalEmbedderOf(decorate(decorate(owner()))), embedder);
  });
  it('a store without one → undefined', () => {
    assert.equal(retrievalEmbedderOf(plain()), undefined);
    assert.equal(retrievalEmbedderOf(decorate(plain())), undefined);
  });
  it('a field that is not an embedder is not one', () => {
    assert.equal(
      retrievalEmbedderOf(Object.assign(plain(), { retrievalEmbedder: {} })),
      undefined,
    );
  });
  it('stops after 16 levels', () => {
    let rag: IRag = owner();
    for (let i = 0; i < 16; i++) rag = decorate(rag);
    assert.equal(retrievalEmbedderOf(rag), undefined);
  });
});
