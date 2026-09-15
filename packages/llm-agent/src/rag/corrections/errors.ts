import { RagError } from '../../interfaces/types.js';

export class ReadOnlyError extends RagError {
  constructor(collectionName: string) {
    super(`Collection '${collectionName}' is read-only`, 'RAG_READ_ONLY');
    this.name = 'ReadOnlyError';
  }
}

export class MissingIdError extends RagError {
  constructor(strategyName: string) {
    super(`${strategyName} requires metadata.id`, 'RAG_MISSING_ID');
    this.name = 'MissingIdError';
  }
}

export class CanonicalKeyCollisionError extends RagError {
  constructor(key: string) {
    super(
      `canonicalKey '${key}' already exists in base; reserved for future overlay-block semantics`,
      'RAG_CANONICAL_KEY_COLLISION',
    );
    this.name = 'CanonicalKeyCollisionError';
  }
}

export class UnsupportedScopeError extends RagError {
  constructor(providerName: string, scope: string) {
    super(
      `Provider '${providerName}' does not support scope '${scope}'`,
      'RAG_UNSUPPORTED_SCOPE',
    );
    this.name = 'UnsupportedScopeError';
  }
}

export class ProviderNotFoundError extends RagError {
  constructor(providerName: string) {
    super(
      `RAG provider '${providerName}' is not registered`,
      'RAG_PROVIDER_NOT_FOUND',
    );
    this.name = 'ProviderNotFoundError';
  }
}

export class CollectionNotFoundError extends RagError {
  constructor(collectionName: string) {
    super(
      `Collection '${collectionName}' is not registered`,
      'RAG_COLLECTION_NOT_FOUND',
    );
    this.name = 'CollectionNotFoundError';
  }
}

/**
 * A collection was unregistered, but nothing could delete its data: its
 * provider is gone, or it has no `deleteCollection` and its store no
 * `writer().clearAll()`.
 */
export class DeleteUnsupportedError extends RagError {
  constructor(collectionName: string, reason: string) {
    super(
      `Collection '${collectionName}' was unregistered, but its data was not deleted: ${reason}`,
      'RAG_DELETE_UNSUPPORTED',
    );
    this.name = 'DeleteUnsupportedError';
  }
}

/**
 * A user or global collection cannot be created under this name: a deletion
 * under it failed, its data may remain, and a provider that keeps stores by
 * name would open them again.
 */
export class CollectionDataRemainsError extends RagError {
  constructor(collectionName: string) {
    super(
      `Collection '${collectionName}' cannot be created: a failed deletion may have left its data, and its provider would open it again`,
      'RAG_COLLECTION_DATA_REMAINS',
    );
    this.name = 'CollectionDataRemainsError';
  }
}

/**
 * A session was closed — every one of its collections unregistered — but the
 * data of some could not be deleted. `failures` names each, with its error.
 */
export class SessionCloseIncompleteError extends RagError {
  constructor(
    sessionId: string,
    readonly failures: ReadonlyArray<{ name: string; error: RagError }>,
  ) {
    super(
      `Session '${sessionId}' closed, but the data of ${failures.length} collection(s) could not be deleted: ${failures
        .map((f) => `${f.name}: ${f.error.message}`)
        .join('; ')}`,
      'RAG_SESSION_CLOSE_INCOMPLETE',
    );
    this.name = 'SessionCloseIncompleteError';
  }
}

export class ScopeViolationError extends RagError {
  constructor(collectionName: string, reason: string) {
    super(
      `Scope violation on '${collectionName}': ${reason}`,
      'RAG_SCOPE_VIOLATION',
    );
    this.name = 'ScopeViolationError';
  }
}
