import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MissingProviderError } from '@mcp-abap-adt/llm-agent';
import { _resetPrefetchedRagForTests, prefetchRagFactories, resolveRag, } from '../rag-factories.js';
describe('rag-factories', () => {
    it('throws MissingProviderError for unknown backend name', async () => {
        _resetPrefetchedRagForTests();
        await assert.rejects(() => prefetchRagFactories(['nope']), MissingProviderError);
    });
    it('throws MissingProviderError at resolveRag when not prefetched', () => {
        _resetPrefetchedRagForTests();
        assert.throws(() => resolveRag('hana-vector', {
            collectionName: 'x',
            embedder: {
                async embed() {
                    return { vector: [0] };
                },
            },
        }), MissingProviderError);
    });
    it('prefetches known packages (qdrant already a workspace dev dep)', async () => {
        _resetPrefetchedRagForTests();
        await prefetchRagFactories(['qdrant']);
        const rag = resolveRag('qdrant', {
            url: 'http://localhost:6333',
            collectionName: 't',
            embedder: {
                async embed() {
                    return { vector: [0, 0, 0] };
                },
            },
        });
        assert.equal(typeof rag.query, 'function');
    });
});
//# sourceMappingURL=rag-factories.test.js.map