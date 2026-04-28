import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PgVectorRag } from '../pg-vector-rag.js';
function makeEmbedder(dim = 3) {
    return {
        async embed(text) {
            let h = 0;
            for (const ch of text)
                h = (h * 31 + ch.charCodeAt(0)) | 0;
            return {
                vector: Array.from({ length: dim }, (_, i) => ((h >> i) & 0xff) / 255),
            };
        },
    };
}
function makeFakeClient(rows = []) {
    const calls = [];
    return {
        calls,
        async query(sql, params = []) {
            calls.push({ sql, params });
            return { rows, rowCount: rows.length };
        },
        async end() { },
    };
}
describe('PgVectorRag', () => {
    it('ensureSchema runs CREATE EXTENSION + CREATE TABLE once', async () => {
        const client = makeFakeClient();
        const rag = new PgVectorRag({ collectionName: 'docs', dimension: 3, embedder: makeEmbedder(3) }, client);
        await rag.ensureSchema();
        await rag.ensureSchema();
        const extCount = client.calls.filter((c) => c.sql.includes('CREATE EXTENSION')).length;
        const tblCount = client.calls.filter((c) => c.sql.includes('CREATE TABLE')).length;
        assert.equal(extCount, 1);
        assert.equal(tblCount, 1);
    });
    it('query uses pgvector <=> distance and maps rows', async () => {
        const rows = [
            { id: 'a', text: 'hello', metadata: { namespace: 'n' }, score: 0.1 },
        ];
        const client = makeFakeClient(rows);
        const rag = new PgVectorRag({ collectionName: 'docs', dimension: 3, embedder: makeEmbedder(3) }, client);
        const r = await rag.query({ text: 'test query', toVector: async () => [0.1, 0.2, 0.3] }, 5);
        assert.equal(r.ok, true);
        if (!r.ok)
            throw new Error('unreachable');
        assert.equal(r.value[0].text, 'hello');
        assert.equal(r.value[0].metadata?.namespace, 'n');
        assert.ok(client.calls.some((c) => c.sql.includes('<=>')));
    });
    it('upsertRaw issues INSERT … ON CONFLICT', async () => {
        const client = makeFakeClient();
        const rag = new PgVectorRag({ collectionName: 'docs', dimension: 3, embedder: makeEmbedder(3) }, client);
        const r = await rag.writer().upsertRaw('id1', 'text', { namespace: 'n' });
        assert.equal(r.ok, true);
        assert.ok(client.calls.some((c) => c.sql.includes('ON CONFLICT')));
    });
    it('deleteByIdRaw issues DELETE', async () => {
        const client = makeFakeClient([{ '?column?': 1 }]);
        const rag = new PgVectorRag({ collectionName: 'docs', dimension: 3, embedder: makeEmbedder(3) }, client);
        const r = await rag.writer().deleteByIdRaw('id1');
        assert.equal(r.ok, true);
        assert.ok(client.calls.some((c) => c.sql.startsWith('DELETE FROM')));
    });
    it('clearAll issues TRUNCATE', async () => {
        const client = makeFakeClient();
        const rag = new PgVectorRag({ collectionName: 'docs', dimension: 3, embedder: makeEmbedder(3) }, client);
        const writer = rag.writer();
        assert.ok(writer.clearAll);
        const r = await writer.clearAll();
        assert.equal(r.ok, true);
        assert.ok(client.calls.some((c) => c.sql.startsWith('TRUNCATE')));
    });
    it('healthCheck runs SELECT 1', async () => {
        const client = makeFakeClient([{ '?column?': 1 }]);
        const rag = new PgVectorRag({ collectionName: 'docs', dimension: 3, embedder: makeEmbedder(3) }, client);
        const r = await rag.healthCheck();
        assert.equal(r.ok, true);
        assert.ok(client.calls.some((c) => c.sql === 'SELECT 1'));
    });
    it('rejects invalid collection name', () => {
        assert.throws(() => new PgVectorRag({ collectionName: "bad'; DROP", embedder: makeEmbedder() }, makeFakeClient()), (err) => err.code === 'INVALID_COLLECTION_NAME');
    });
});
//# sourceMappingURL=pg-vector-rag.test.js.map