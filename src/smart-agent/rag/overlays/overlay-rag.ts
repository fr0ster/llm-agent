import type { IQueryEmbedding } from '../../interfaces/query-embedding.js';
import type { IRag } from '../../interfaces/rag.js';
import type {
  CallOptions,
  RagError,
  RagMetadata,
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
    const [baseRes, overlayRes] = await Promise.all([
      this.base.query(embedding, k, options),
      this.overlay.query(embedding, k, options),
    ]);
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
    if (this.overlay.getById) {
      const o = await this.overlay.getById(id, options);
      if (!o.ok) return o;
      if (o.value !== null && this.overlayAllows(o.value)) return o;
    }
    if (!this.base.getById) return { ok: true, value: null };
    return this.base.getById(id, options);
  }

  async healthCheck(options?: CallOptions): Promise<Result<void, RagError>> {
    const [a, b] = await Promise.all([
      this.base.healthCheck(options),
      this.overlay.healthCheck(options),
    ]);
    if (!a.ok) return a;
    return b;
  }

  // Required by IRag but not meaningful for a read-only overlay wrapper.
  // Delegates to base to satisfy the interface.
  async upsert(
    text: string,
    metadata: RagMetadata,
    options?: CallOptions,
  ): Promise<Result<void, RagError>> {
    return this.base.upsert(text, metadata, options);
  }

  /** Hook for subclasses to drop overlay rows (e.g. by sessionId). */
  protected filterOverlay(results: RagResult[]): RagResult[] {
    return results;
  }

  protected overlayAllows(_result: RagResult): boolean {
    return true;
  }
}
