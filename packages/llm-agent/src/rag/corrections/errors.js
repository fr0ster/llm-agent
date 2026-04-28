import { RagError } from '../../interfaces/types.js';
export class ReadOnlyError extends RagError {
    constructor(collectionName) {
        super(`Collection '${collectionName}' is read-only`, 'RAG_READ_ONLY');
        this.name = 'ReadOnlyError';
    }
}
export class MissingIdError extends RagError {
    constructor(strategyName) {
        super(`${strategyName} requires metadata.id`, 'RAG_MISSING_ID');
        this.name = 'MissingIdError';
    }
}
export class CanonicalKeyCollisionError extends RagError {
    constructor(key) {
        super(`canonicalKey '${key}' already exists in base; reserved for future overlay-block semantics`, 'RAG_CANONICAL_KEY_COLLISION');
        this.name = 'CanonicalKeyCollisionError';
    }
}
export class UnsupportedScopeError extends RagError {
    constructor(providerName, scope) {
        super(`Provider '${providerName}' does not support scope '${scope}'`, 'RAG_UNSUPPORTED_SCOPE');
        this.name = 'UnsupportedScopeError';
    }
}
export class ProviderNotFoundError extends RagError {
    constructor(providerName) {
        super(`RAG provider '${providerName}' is not registered`, 'RAG_PROVIDER_NOT_FOUND');
        this.name = 'ProviderNotFoundError';
    }
}
export class CollectionNotFoundError extends RagError {
    constructor(collectionName) {
        super(`Collection '${collectionName}' is not registered`, 'RAG_COLLECTION_NOT_FOUND');
        this.name = 'CollectionNotFoundError';
    }
}
export class ScopeViolationError extends RagError {
    constructor(collectionName, reason) {
        super(`Scope violation on '${collectionName}': ${reason}`, 'RAG_SCOPE_VIOLATION');
        this.name = 'ScopeViolationError';
    }
}
//# sourceMappingURL=errors.js.map