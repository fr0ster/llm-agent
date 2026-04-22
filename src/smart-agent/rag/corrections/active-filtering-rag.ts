import type { IQueryEmbedding } from '../../interfaces/query-embedding.js';
import type { IRag } from '../../interfaces/rag.js';
import type {
  CallOptions,
  RagError,
  RagResult,
  Result,
} from '../../interfaces/types.js';
import { type CorrectionMetadata, filterActive } from './metadata.js';

function includeInactive(options?: CallOptions): boolean {
  return Boolean(
    (options?.ragFilter as { includeInactive?: boolean } | undefined)
      ?.includeInactive,
  );
}

export class ActiveFilteringRag implements IRag {
  constructor(private readonly inner: IRag) {}

  async query(
    embedding: IQueryEmbedding,
    k: number,
    options?: CallOptions,
  ): Promise<Result<RagResult[], RagError>> {
    const res = await this.inner.query(embedding, k, options);
    if (!res.ok) return res;
    const filtered = filterActive(
      res.value,
      (r) => r.metadata as unknown as CorrectionMetadata,
      { includeInactive: includeInactive(options) },
    );
    return { ok: true, value: filtered };
  }

  async getById(
    id: string,
    options?: CallOptions,
  ): Promise<Result<RagResult | null, RagError>> {
    const res = await this.inner.getById(id, options);
    if (!res.ok || res.value === null) return res;
    const tags =
      (res.value.metadata as unknown as CorrectionMetadata).tags ?? [];
    const inactive = tags.includes('deprecated') || tags.includes('superseded');
    if (inactive && !includeInactive(options)) {
      return { ok: true, value: null };
    }
    return res;
  }

  healthCheck(options?: CallOptions): Promise<Result<void, RagError>> {
    return this.inner.healthCheck(options);
  }
}
