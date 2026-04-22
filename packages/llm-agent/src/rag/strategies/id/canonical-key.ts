import type { IIdStrategy } from '../../../interfaces/rag.js';
import type { RagMetadata } from '../../../interfaces/types.js';
import { MissingIdError } from '../../corrections/errors.js';

export class CanonicalKeyIdStrategy implements IIdStrategy {
  resolve(metadata: RagMetadata, _text: string): string {
    const key = metadata.canonicalKey;
    if (typeof key !== 'string' || key.length === 0) {
      throw new MissingIdError('CanonicalKeyIdStrategy');
    }
    const version =
      typeof metadata.version === 'number' && metadata.version > 0
        ? metadata.version
        : 1;
    return `${key}:v${version}`;
  }
}
