import type { IRag } from '../../interfaces/rag.js';
import type { RagResult } from '../../interfaces/types.js';
import { OverlayRag } from './overlay-rag.js';

export class SessionScopedRag extends OverlayRag {
  constructor(
    base: IRag,
    overlay: IRag,
    private readonly sessionId: string,
    private readonly ttlMs?: number,
  ) {
    super(base, overlay);
  }

  protected override filterOverlay(results: RagResult[]): RagResult[] {
    const cutoff =
      this.ttlMs !== undefined ? Date.now() - this.ttlMs : undefined;
    return results.filter((r) => this.matches(r, cutoff));
  }

  protected override overlayAllows(result: RagResult): boolean {
    const cutoff =
      this.ttlMs !== undefined ? Date.now() - this.ttlMs : undefined;
    return this.matches(result, cutoff);
  }

  private matches(result: RagResult, cutoffMs: number | undefined): boolean {
    if (result.metadata.sessionId !== this.sessionId) return false;
    if (cutoffMs !== undefined) {
      const createdMs =
        typeof result.metadata.createdAt === 'number'
          ? result.metadata.createdAt
          : undefined;
      if (createdMs !== undefined && createdMs < cutoffMs) return false;
    }
    return true;
  }
}
