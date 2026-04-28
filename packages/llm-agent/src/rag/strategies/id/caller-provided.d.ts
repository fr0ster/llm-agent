import type { IIdStrategy } from '../../../interfaces/rag.js';
import type { RagMetadata } from '../../../interfaces/types.js';
export declare class CallerProvidedIdStrategy implements IIdStrategy {
  resolve(metadata: RagMetadata, _text: string): string;
}
//# sourceMappingURL=caller-provided.d.ts.map
