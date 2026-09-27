import type { RagCollectionScope } from '../../interfaces/rag.js';
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

/** Attributes JSON would not return unchanged: NaN, ±Infinity, a cycle, or no JSON form. */
export class InvalidAttributesError extends RagError {
  constructor(readonly reason: string) {
    super(
      `Collection attributes cannot be stored as JSON unchanged: ${reason}`,
      'RAG_INVALID_ATTRIBUTES',
    );
    this.name = 'InvalidAttributesError';
  }
}

/** A scope without the owner key it selects, or no known scope at all. */
export class InvalidOwnerError extends RagError {
  constructor(readonly reason: string) {
    super(`Collection owner is invalid: ${reason}`, 'RAG_INVALID_OWNER');
    this.name = 'InvalidOwnerError';
  }
}

/** The collection is taken: its catalog record (or a registry entry) exists. */
export class DuplicateCollectionError extends RagError {
  constructor(collectionName: string, detail?: string) {
    super(
      `Collection '${collectionName}' already exists${detail ? `: ${detail}` : ''}`,
      'RAG_DUPLICATE_COLLECTION',
    );
    this.name = 'DuplicateCollectionError';
  }
}

/**
 * A store exists without a catalog record — at this moment: another session may
 * be creating or deleting it, so a retry later may find a finished collection or
 * a free name. Adopt it with `adoptExisting`, or remove it.
 */
export class OrphanStoreError extends RagError {
  constructor(
    readonly storeName: string,
    reason: string,
  ) {
    super(
      `Store '${storeName}' has no catalog record: ${reason}`,
      'RAG_ORPHAN_STORE',
    );
    this.name = 'OrphanStoreError';
  }
}

/** A name held in several scopes of one registry, addressed without a scope. */
export class AmbiguousCollectionError extends RagError {
  constructor(
    collectionName: string,
    readonly scopes: readonly RagCollectionScope[],
  ) {
    super(
      `Collection '${collectionName}' exists in several scopes (${scopes.join(', ')}); name the scope`,
      'RAG_AMBIGUOUS_COLLECTION',
    );
    this.name = 'AmbiguousCollectionError';
  }
}

/**
 * The first step of a catalogued deletion failed: the record could not be
 * removed, so the data was not touched and nothing was deleted — retry it.
 */
export class CatalogRecordDeleteError extends RagError {
  constructor(
    readonly storeName: string,
    reason: string,
  ) {
    super(
      `The catalog record of store '${storeName}' could not be deleted, so nothing was deleted: ${reason}`,
      'RAG_CATALOG_RECORD_DELETE',
    );
    this.name = 'CatalogRecordDeleteError';
  }
}

/**
 * A global named into a prefix the `ragStores` projection gives another scope
 * (§6.4): it would take that scope's key, and one entry would silently
 * overwrite the other. Thrown by `register` and `adopt`, returned by
 * `createCollection` (Tasks B23, B24).
 */
export class ReservedCollectionNameError extends RagError {
  constructor(
    collectionName: string,
    readonly prefix: string,
  ) {
    super(
      `A global collection may not be named '${collectionName}': the prefix '${prefix}' is reserved for the ${prefix.slice(0, -1)} scope`,
      'RAG_RESERVED_COLLECTION_NAME',
    );
    this.name = 'ReservedCollectionNameError';
  }
}
