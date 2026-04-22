import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RagError } from '../../interfaces/types.js';
import {
  CanonicalKeyCollisionError,
  MissingIdError,
  ReadOnlyError,
} from '../corrections/errors.js';

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
