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
