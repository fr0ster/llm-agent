import type { IIdStrategy } from '../../../interfaces/rag.js';
import type { RagMetadata } from '../../../interfaces/types.js';
import { MissingIdError } from '../../corrections/errors.js';

export class CallerProvidedIdStrategy implements IIdStrategy {
  resolve(metadata: RagMetadata, _text: string): string {
    if (typeof metadata.id !== 'string' || metadata.id.length === 0) {
      throw new MissingIdError('CallerProvidedIdStrategy');
    }
    return metadata.id;
  }
}
