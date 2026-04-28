import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertCollectionName, createExtensionSql, createTableSql, dropTableSql, quoteIdent, } from '../schema.js';
describe('pg schema', () => {
    it('accepts a safe collection name', () => {
        assertCollectionName('docs_2');
    });
    it('rejects digit-led name', () => {
        assert.throws(() => assertCollectionName('1bad'), (err) => err.code === 'INVALID_COLLECTION_NAME');
    });
    it('rejects punctuation', () => {
        assert.throws(() => assertCollectionName("x'); DROP"), (err) => err.code === 'INVALID_COLLECTION_NAME');
    });
    it('quotes identifiers with double-quotes', () => {
        assert.equal(quoteIdent('docs'), '"docs"');
    });
    it('emits CREATE EXTENSION IF NOT EXISTS vector', () => {
        assert.match(createExtensionSql(), /CREATE EXTENSION IF NOT EXISTS vector/);
    });
    it('emits CREATE TABLE with vector(n) and jsonb', () => {
        const sql = createTableSql('docs', 1536);
        assert.match(sql, /CREATE TABLE IF NOT EXISTS "docs"/);
        assert.match(sql, /vector\(1536\)/);
        assert.match(sql, /metadata JSONB/);
    });
    it('emits DROP TABLE DDL', () => {
        assert.equal(dropTableSql('docs'), 'DROP TABLE IF EXISTS "docs"');
    });
});
//# sourceMappingURL=schema.test.js.map