import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IEmbedder } from '../../interfaces/rag.js';
import { TextOnlyEmbedding } from '../query-embedding.js';
import { VectorRag } from '../vector-rag.js';

const fakeEmbedder: IEmbedder = {
  embed: async (text) => ({
    vector: Array.from(text.slice(0, 8).padEnd(8, ' ')).map(
      (c) => c.charCodeAt(0) / 255,
    ),
  }),
};

describe('VectorRag.getById', () => {
  it('retrieves by metadata.id after upsert', async () => {
    const rag = new VectorRag(fakeEmbedder);
    await rag.upsert('hello', { id: 'v1' });
    const got = await rag.getById?.('v1');
    assert.ok(got?.ok);
    assert.ok(got?.value);
    assert.equal(got?.value?.text, 'hello');
  });
  it('returns null for unknown id', async () => {
    const rag = new VectorRag(fakeEmbedder);
    const got = await rag.getById?.('nope');
    assert.ok(got?.ok);
    assert.equal(got?.value, null);
  });
});

describe('VectorRag backend writer', () => {
  it('upsertRaw adds a record', async () => {
    const rag = new VectorRag(fakeEmbedder);
    const w = rag.writer();
    const up = await w.upsertRaw('v1', 'hi there', {});
    assert.ok(up.ok);
    const got = await rag.getById?.('v1');
    assert.ok(got?.ok && got.value?.text === 'hi there');
  });
  it('deleteByIdRaw removes the record and returns whether it existed', async () => {
    const rag = new VectorRag(fakeEmbedder);
    const w = rag.writer();
    await w.upsertRaw('v1', 'hi', {});
    const first = await w.deleteByIdRaw('v1');
    assert.ok(first.ok && first.value === true);
    const miss = await w.deleteByIdRaw('v1');
    assert.ok(miss.ok && miss.value === false);
    const got = await rag.getById?.('v1');
    assert.ok(got?.ok && got.value === null);
  });
  it('queries skip deleted records', async () => {
    const rag = new VectorRag(fakeEmbedder);
    const w = rag.writer();
    await w.upsertRaw('v1', 'keepable', {});
    await w.upsertRaw('v2', 'removable', {});
    await w.deleteByIdRaw('v2');
    const res = await rag.query(new TextOnlyEmbedding('removable'), 10);
    assert.ok(res.ok);
    const texts = res.value.map((r) => r.text);
    assert.ok(!texts.includes('removable'));
  });
  it('clearAll empties the store', async () => {
    const rag = new VectorRag(fakeEmbedder);
    const w = rag.writer();
    await w.upsertRaw('v1', 'x', {});
    const cleared = await w.clearAll?.();
    assert.ok(cleared?.ok);
    const got = await rag.getById?.('v1');
    assert.ok(got?.ok && got.value === null);
  });
});
