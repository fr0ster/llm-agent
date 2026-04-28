import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RagQueryHandler } from '../rag-query.js';
function makeSpan() {
    return {
        setAttribute() { },
        setStatus() { },
        addEvent() { },
        end() { },
    };
}
function makeStore(capture) {
    return {
        async query(embedding, _k, _opts) {
            capture.embedding = embedding;
            return { ok: true, value: [] };
        },
        async upsert() {
            return { ok: true, value: undefined };
        },
        async healthCheck() {
            return { ok: true, value: undefined };
        },
    };
}
function makeCtx(partial) {
    return {
        ragText: 'default-rag-text',
        toolQueryText: undefined,
        ragStores: {},
        queryEmbedding: undefined,
        embedder: undefined,
        options: undefined,
        sessionId: 's',
        config: { ragQueryK: 5 },
        metrics: {
            ragQueryCount: { add() { } },
        },
        requestLogger: {
            logRagQuery() { },
            logLlmCall() { },
        },
        ragResults: {},
        ...partial,
    };
}
describe('RagQueryHandler queryText override', () => {
    it('uses ctx.toolQueryText when queryText="toolQueryText"', async () => {
        const capture = {};
        const ctx = makeCtx({
            ragText: 'user-question',
            toolQueryText: 'enriched-context',
            ragStores: { tools: makeStore(capture) },
        });
        const ok = await new RagQueryHandler().execute(ctx, { store: 'tools', queryText: 'toolQueryText' }, makeSpan());
        assert.equal(ok, true);
        assert.equal(capture.embedding.text, 'enriched-context');
    });
    it('does NOT populate ctx.queryEmbedding when queryText override is set', async () => {
        const capture = {};
        const ctx = makeCtx({
            ragText: 'user-question',
            toolQueryText: 'enriched-context',
            ragStores: { tools: makeStore(capture) },
        });
        await new RagQueryHandler().execute(ctx, { store: 'tools', queryText: 'toolQueryText' }, makeSpan());
        assert.equal(ctx.queryEmbedding, undefined);
    });
    it('falls back to ragText when toolQueryText is undefined', async () => {
        const capture = {};
        const ctx = makeCtx({
            ragText: 'user-question',
            toolQueryText: undefined,
            ragStores: { tools: makeStore(capture) },
        });
        await new RagQueryHandler().execute(ctx, { store: 'tools', queryText: 'toolQueryText' }, makeSpan());
        assert.equal(capture.embedding.text, 'user-question');
    });
    it('uses literal queryText string when provided', async () => {
        const capture = {};
        const ctx = makeCtx({
            ragText: 'default',
            ragStores: { x: makeStore(capture) },
        });
        await new RagQueryHandler().execute(ctx, { store: 'x', queryText: 'literal-override' }, makeSpan());
        assert.equal(capture.embedding.text, 'literal-override');
    });
    it('without queryText caches embedding in ctx.queryEmbedding', async () => {
        const capture = {};
        const ctx = makeCtx({
            ragText: 'user-question',
            ragStores: { tools: makeStore(capture) },
        });
        await new RagQueryHandler().execute(ctx, { store: 'tools' }, makeSpan());
        assert.ok(ctx.queryEmbedding);
        assert.equal(ctx.queryEmbedding.text, 'user-question');
    });
});
//# sourceMappingURL=rag-query-override.test.js.map