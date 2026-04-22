import { randomUUID } from 'node:crypto';
import type { IIdStrategy } from '../../../interfaces/rag.js';
import type { RagMetadata } from '../../../interfaces/types.js';

export class SessionScopedIdStrategy implements IIdStrategy {
  constructor(private readonly sessionId: string) {}

  resolve(metadata: RagMetadata, _text: string): string {
    const suffix =
      (typeof metadata.id === 'string' && metadata.id) ||
      (typeof metadata.canonicalKey === 'string' && metadata.canonicalKey) ||
      randomUUID();
    return `${this.sessionId}:${suffix}`;
  }
}
