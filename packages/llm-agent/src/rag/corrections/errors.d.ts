import { RagError } from '../../interfaces/types.js';
export declare class ReadOnlyError extends RagError {
    constructor(collectionName: string);
}
export declare class MissingIdError extends RagError {
    constructor(strategyName: string);
}
export declare class CanonicalKeyCollisionError extends RagError {
    constructor(key: string);
}
export declare class UnsupportedScopeError extends RagError {
    constructor(providerName: string, scope: string);
}
export declare class ProviderNotFoundError extends RagError {
    constructor(providerName: string);
}
export declare class CollectionNotFoundError extends RagError {
    constructor(collectionName: string);
}
export declare class ScopeViolationError extends RagError {
    constructor(collectionName: string, reason: string);
}
//# sourceMappingURL=errors.d.ts.map