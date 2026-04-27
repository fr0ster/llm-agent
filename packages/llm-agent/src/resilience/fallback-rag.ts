/**
 * FallbackRag — IRag decorator wrapping a primary and fallback store.
 *
 * - **write** — writes go through writer(); fans out to both stores (best-effort for fallback).
 * - **query** — uses primary when the embedder breaker is closed/half-open;
 *   routes to fallback when the breaker is open.
 * - **healthCheck** — delegates to primary.
 */

import type {
  CallOptions,
  IQueryEmbedding,
  IRag,
  IRagBackendWriter,
  RagError,
  RagResult,
  Result,
} from '@mcp-abap-adt/llm-agent';
import type { CircuitBreaker } from './circuit-breaker.js';

export class FallbackRag implements IRag {
  constructor(
    private readonly primary: IRag,
    private readonly fallback: IRag,
    private readonly embedderBreaker: CircuitBreaker,
  ) {}

  async getById(
    id: string,
    options?: CallOptions,
  ): Promise<Result<RagResult | null, RagError>> {
    const res = await this.primary.getById(id, options);
    if (res.ok && res.value !== null) return res;
    return this.fallback.getById(id, options);
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

  async healthCheck(options?: CallOptions): Promise<Result<void, RagError>> {
    return this.primary.healthCheck(options);
  }

  writer(): IRagBackendWriter | undefined {
    const pw = this.primary.writer?.();
    const fw = this.fallback.writer?.();
    if (!pw && !fw) return undefined;
    return {
      upsertRaw: async (id, text, metadata, options) => {
        const pres = pw
          ? await pw.upsertRaw(id, text, metadata, options)
          : ({ ok: true, value: undefined } as const);
        if (fw) fw.upsertRaw(id, text, metadata, options).catch(() => {});
        return pres;
      },
      deleteByIdRaw: async (id, options) => {
        const pres = pw
          ? await pw.deleteByIdRaw(id, options)
          : ({ ok: true, value: false } as const);
        if (fw) fw.deleteByIdRaw(id, options).catch(() => {});
        return pres;
      },
      clearAll: async () => {
        const pres = pw?.clearAll
          ? await pw.clearAll()
          : ({ ok: true, value: undefined } as const);
        if (fw?.clearAll) fw.clearAll().catch(() => {});
        return pres;
      },
      upsertPrecomputedRaw: async (id, text, vector, metadata, options) => {
        const pres = pw?.upsertPrecomputedRaw
          ? await pw.upsertPrecomputedRaw(id, text, vector, metadata, options)
          : pw
            ? await pw.upsertRaw(id, text, metadata, options)
            : ({ ok: true, value: undefined } as const);
        if (fw?.upsertPrecomputedRaw) {
          fw.upsertPrecomputedRaw(id, text, vector, metadata, options).catch(
            () => {},
          );
        } else if (fw) {
          fw.upsertRaw(id, text, metadata, options).catch(() => {});
        }
        return pres;
      },
    };
  }
}
