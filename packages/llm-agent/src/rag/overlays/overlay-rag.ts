import { collectWithContextOverflow } from '../../errors/collect-with-context-overflow.js';
import {
  contextExceededError,
  terminalRunError,
} from '../../errors/terminal-run-error.js';
import type { IQueryEmbedding } from '../../interfaces/query-embedding.js';
import type { IRag } from '../../interfaces/rag.js';
import type {
  CallOptions,
  RagError,
  RagResult,
  Result,
} from '../../interfaces/types.js';

export class OverlayRag implements IRag {
  constructor(
    protected readonly base: IRag,
    protected readonly overlay: IRag,
  ) {}

  async query(
    embedding: IQueryEmbedding,
    k: number,
    options?: CallOptions,
  ): Promise<Result<RagResult[], RagError>> {
    const baseQuery = this.base.query(embedding, k, options);
    const overlayQuery = this.overlay.query(embedding, k, options);
    const [base, overlay, combined] = await Promise.allSettled([
      baseQuery,
      overlayQuery,
      Promise.all([baseQuery, overlayQuery]),
    ]);
    const failures = [base, overlay].map((result) =>
      result.status === 'rejected'
        ? result.reason
        : result.value.ok
          ? undefined
          : result.value.error,
    );
    for (const error of failures) {
      const overflow = contextExceededError(error);
      if (overflow) return { ok: false, error: overflow };
    }
    for (const error of failures) {
      const terminal = terminalRunError(error);
      if (terminal) return { ok: false, error: terminal };
    }
    // Promise.all retains the first ordinary rejection in settlement order.
    if (combined.status === 'rejected') throw combined.reason;
    const [baseRes, overlayRes] = combined.value;
    if (!baseRes.ok) return baseRes;
    if (!overlayRes.ok) return overlayRes;

    const overlayList = this.filterOverlay(overlayRes.value);
    const overlayKeys = new Set(
      overlayList
        .map((r) => r.metadata.canonicalKey)
        .filter((key): key is string => typeof key === 'string'),
    );
    const baseKept = baseRes.value.filter((r) => {
      const key = r.metadata.canonicalKey;
      return typeof key !== 'string' || !overlayKeys.has(key);
    });
    const merged = [...overlayList, ...baseKept]
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
    return { ok: true, value: merged };
  }

  async getById(
    id: string,
    options?: CallOptions,
  ): Promise<Result<RagResult | null, RagError>> {
    const o = await this.overlay.getById(id, options);
    if (!o.ok) return o;
    if (o.value !== null && this.overlayAllows(o.value)) return o;
    return this.base.getById(id, options);
  }

  async healthCheck(options?: CallOptions): Promise<Result<void, RagError>> {
    const checks = await collectWithContextOverflow(
      [this.base, this.overlay].map((store) => store.healthCheck(options)),
      (result) => (result.ok ? undefined : result.error),
    );
    if (!checks.ok) return checks;
    const [a, b] = checks.value;
    if (!a.ok) return a;
    return b;
  }

  /** Hook for subclasses to drop overlay rows (e.g. by sessionId). */
  protected filterOverlay(results: RagResult[]): RagResult[] {
    return results;
  }

  protected overlayAllows(_result: RagResult): boolean {
    return true;
  }
}
