import type { IIdStrategy } from '../../../interfaces/rag.js';
import type { RagMetadata } from '../../../interfaces/types.js';
export declare class SessionScopedIdStrategy implements IIdStrategy {
  private readonly sessionId;
  constructor(sessionId: string);
  resolve(metadata: RagMetadata, _text: string): string;
}
//# sourceMappingURL=session-scoped.d.ts.map
