import type { IRag } from '../../interfaces/rag.js';
import type { RagResult } from '../../interfaces/types.js';
import { OverlayRag } from './overlay-rag.js';
export declare class SessionScopedRag extends OverlayRag {
  private readonly sessionId;
  private readonly ttlMs?;
  constructor(
    base: IRag,
    overlay: IRag,
    sessionId: string,
    ttlMs?: number | undefined,
  );
  protected filterOverlay(results: RagResult[]): RagResult[];
  protected overlayAllows(result: RagResult): boolean;
  private matches;
}
//# sourceMappingURL=session-scoped-rag.d.ts.map
