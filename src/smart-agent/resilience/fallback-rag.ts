/**
 * FallbackRag — IRag decorator wrapping a primary and fallback store.
 *
 * - **upsert** — always writes to both stores (best-effort for fallback).
 * - **query** — uses primary when the embedder breaker is closed/half-open;
 *   routes to fallback when the breaker is open.
 * - **healthCheck** — delegates to primary.
 */

import type { IQueryEmbedding } from '../interfaces/query-embedding.js';
import type { IRag } from '../interfaces/rag.js';
import { supportsPrecomputed } from '../interfaces/rag.js';
import type {
  CallOptions,
  RagError,
  RagMetadata,
  RagResult,
  Result,
} from '../interfaces/types.js';
import type { CircuitBreaker } from './circuit-breaker.js';

export class FallbackRag implements IRag {
  constructor(
    private readonly primary: IRag,
    private readonly fallback: IRag,
    private readonly embedderBreaker: CircuitBreaker,
  ) {}

  async upsert(
    text: string,
    metadata: RagMetadata,
    options?: CallOptions,
  ): Promise<Result<void, RagError>> {
    const [primaryResult] = await Promise.all([
      this.primary.upsert(text, metadata, options),
      this.fallback.upsert(text, metadata, options).catch(() => {}),
    ]);
    return primaryResult;
  }

  async query(
    embedding: IQueryEmbedding,
    k: number,
    options?: CallOptions,
  ): Promise<Result<RagResult[], RagError>> {
    if (this.embedderBreaker.state === 'open') {
      return this.fallback.query(embedding, k, options);
    }
    return this.primary.query(embedding, k, options);
  }

  async upsertPrecomputed(
    text: string,
    vector: number[],
    metadata: RagMetadata,
    options?: CallOptions,
  ): Promise<Result<void, RagError>> {
    const primaryResult = supportsPrecomputed(this.primary)
      ? await this.primary.upsertPrecomputed(text, vector, metadata, options)
      : await this.primary.upsert(text, metadata, options);

    // Best-effort write to fallback
    if (supportsPrecomputed(this.fallback)) {
      this.fallback
        .upsertPrecomputed(text, vector, metadata, options)
        .catch(() => {});
    } else {
      this.fallback.upsert(text, metadata, options).catch(() => {});
    }

    return primaryResult;
  }

  async healthCheck(options?: CallOptions): Promise<Result<void, RagError>> {
    return this.primary.healthCheck(options);
  }
}
