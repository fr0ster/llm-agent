import { randomUUID } from 'node:crypto';
import type { IIdStrategy } from '../../../interfaces/rag.js';
import type { RagMetadata } from '../../../interfaces/types.js';

export class GlobalUniqueIdStrategy implements IIdStrategy {
  resolve(metadata: RagMetadata, _text: string): string {
    return typeof metadata.id === 'string' && metadata.id.length > 0
      ? metadata.id
      : randomUUID();
  }
}
