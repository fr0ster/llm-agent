import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RagError } from '../../interfaces/types.js';
import { CanonicalKeyCollisionError, CollectionNotFoundError, MissingIdError, ProviderNotFoundError, ReadOnlyError, ScopeViolationError, UnsupportedScopeError, } from '../corrections/errors.js';
describe('corrections errors', () => {
    it('ReadOnlyError extends RagError with code', () => {
        const e = new ReadOnlyError('corp-facts');
        assert.ok(e instanceof RagError);
        assert.equal(e.code, 'RAG_READ_ONLY');
        assert.match(e.message, /corp-facts/);
    });
    it('MissingIdError extends RagError with code', () => {
        const e = new MissingIdError('CallerProvidedIdStrategy');
        assert.ok(e instanceof RagError);
        assert.equal(e.code, 'RAG_MISSING_ID');
        assert.match(e.message, /CallerProvidedIdStrategy/);
    });
    it('CanonicalKeyCollisionError extends RagError with code', () => {
        const e = new CanonicalKeyCollisionError('doc-42');
        assert.ok(e instanceof RagError);
        assert.equal(e.code, 'RAG_CANONICAL_KEY_COLLISION');
        assert.match(e.message, /doc-42/);
    });
});
describe('v9.1 errors', () => {
    it('UnsupportedScopeError has code and mentions provider and scope', () => {
        const e = new UnsupportedScopeError('qdrant-rw', 'global');
        assert.ok(e instanceof RagError);
        assert.equal(e.code, 'RAG_UNSUPPORTED_SCOPE');
        assert.match(e.message, /qdrant-rw/);
        assert.match(e.message, /global/);
    });
    it('ProviderNotFoundError has code and mentions name', () => {
        const e = new ProviderNotFoundError('missing-provider');
        assert.ok(e instanceof RagError);
        assert.equal(e.code, 'RAG_PROVIDER_NOT_FOUND');
        assert.match(e.message, /missing-provider/);
    });
    it('CollectionNotFoundError has code and mentions name', () => {
        const e = new CollectionNotFoundError('phase-1');
        assert.ok(e instanceof RagError);
        assert.equal(e.code, 'RAG_COLLECTION_NOT_FOUND');
        assert.match(e.message, /phase-1/);
    });
    it('ScopeViolationError has code and mentions name and reason', () => {
        const e = new ScopeViolationError('corp-facts', 'sessionId mismatch');
        assert.ok(e instanceof RagError);
        assert.equal(e.code, 'RAG_SCOPE_VIOLATION');
        assert.match(e.message, /corp-facts/);
        assert.match(e.message, /sessionId mismatch/);
    });
});
//# sourceMappingURL=corrections-errors.test.js.map