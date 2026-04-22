import type { IRagEditor } from '../../../interfaces/rag.js';
import type { RagError, Result } from '../../../interfaces/types.js';
import { ReadOnlyError } from '../../corrections/errors.js';

export class ImmutableEditStrategy implements IRagEditor {
  constructor(private readonly collectionName = 'immutable') {}

  async upsert(): Promise<Result<{ id: string }, RagError>> {
    return { ok: false, error: new ReadOnlyError(this.collectionName) };
  }

  async deleteById(): Promise<Result<boolean, RagError>> {
    return { ok: false, error: new ReadOnlyError(this.collectionName) };
  }
}
