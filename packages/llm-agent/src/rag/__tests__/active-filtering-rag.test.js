import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ActiveFilteringRag } from '../corrections/active-filtering-rag.js';
import { TextOnlyEmbedding } from '../query-embedding.js';
function stubRag(results) {
    return {
        query: async () => ({ ok: true, value: results }),
        getById: async (id) => ({
            ok: true,
            value: results.find((r) => r.metadata.id === id) ?? null,
        }),
        healthCheck: async () => ({ ok: true, value: undefined }),
        upsert: async () => ({ ok: true, value: undefined }),
    };
}
describe('ActiveFilteringRag', () => {
    const results = [
        { text: 'a', metadata: { id: '1', canonicalKey: 'a' }, score: 1 },
        {
            text: 'b',
            metadata: { id: '2', canonicalKey: 'b', tags: ['deprecated'] },
            score: 0.9,
        },
        {
            text: 'c',
            metadata: { id: '3', canonicalKey: 'c', tags: ['superseded'] },
            score: 0.8,
        },
    ];
    it('hides deprecated and superseded on query by default', async () => {
        const rag = new ActiveFilteringRag(stubRag(results));
        const res = await rag.query(new TextOnlyEmbedding('q'), 10);
        assert.ok(res.ok);
        assert.deepEqual(res.value.map((r) => r.metadata.id), ['1']);
    });
    it('returns all when includeInactive is true', async () => {
        const rag = new ActiveFilteringRag(stubRag(results));
        const res = await rag.query(new TextOnlyEmbedding('q'), 10, {
            ragFilter: { includeInactive: true },
        });
        assert.ok(res.ok && res.value.length === 3);
    });
    it('getById returns null for deprecated by default', async () => {
        const rag = new ActiveFilteringRag(stubRag(results));
        const res = await rag.getById?.('2');
        assert.ok(res?.ok && res.value === null);
    });
    it('getById returns deprecated when includeInactive is set', async () => {
        const rag = new ActiveFilteringRag(stubRag(results));
        const res = await rag.getById?.('2', {
            ragFilter: { includeInactive: true },
        });
        assert.ok(res?.ok && res.value !== null);
    });
});
//# sourceMappingURL=active-filtering-rag.test.js.map