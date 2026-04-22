import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IEmbedder } from '../../interfaces/rag.js';
import { VectorRagProvider } from '../providers/vector-rag-provider.js';
import { VectorRag } from '../vector-rag.js';

const fakeEmbedder: IEmbedder = {
  embed: async (text) => ({
    vector: Array.from(text.slice(0, 4).padEnd(4, ' ')).map(
      (c) => c.charCodeAt(0) / 255,
    ),
  }),
};

describe('VectorRagProvider', () => {
  it('creates a VectorRag per collection', async () => {
    const p = new VectorRagProvider({ name: 'vec', embedder: fakeEmbedder });
    const res = await p.createCollection('x', {
      scope: 'session',
      sessionId: 'S',
    });
    assert.ok(res.ok);
    assert.ok(res.value.rag instanceof VectorRag);
    const up = await res.value.editor.upsert('hi', { id: 'r1' });
    assert.ok(up.ok);
    const got = await res.value.rag.getById(up.value.id);
    assert.ok(got.ok && got.value?.text === 'hi');
  });

  it('supports only session scope', () => {
    const p = new VectorRagProvider({ name: 'vec', embedder: fakeEmbedder });
    assert.deepEqual(p.supportedScopes, ['session']);
  });
});
