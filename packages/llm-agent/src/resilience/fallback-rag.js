/**
 * FallbackRag — IRag decorator wrapping a primary and fallback store.
 *
 * - **write** — writes go through writer(); fans out to both stores (best-effort for fallback).
 * - **query** — uses primary when the embedder breaker is closed/half-open;
 *   routes to fallback when the breaker is open.
 * - **healthCheck** — delegates to primary.
 */
export class FallbackRag {
  primary;
  fallback;
  embedderBreaker;
  constructor(primary, fallback, embedderBreaker) {
    this.primary = primary;
    this.fallback = fallback;
    this.embedderBreaker = embedderBreaker;
  }
  async getById(id, options) {
    const res = await this.primary.getById(id, options);
    if (res.ok && res.value !== null) return res;
    return this.fallback.getById(id, options);
  }
  async query(embedding, k, options) {
    if (this.embedderBreaker.state === 'open') {
      return this.fallback.query(embedding, k, options);
    }
    return this.primary.query(embedding, k, options);
  }
  async healthCheck(options) {
    return this.primary.healthCheck(options);
  }
  writer() {
    const pw = this.primary.writer?.();
    const fw = this.fallback.writer?.();
    if (!pw && !fw) return undefined;
    return {
      upsertRaw: async (id, text, metadata, options) => {
        const pres = pw
          ? await pw.upsertRaw(id, text, metadata, options)
          : { ok: true, value: undefined };
        if (fw) fw.upsertRaw(id, text, metadata, options).catch(() => {});
        return pres;
      },
      deleteByIdRaw: async (id, options) => {
        const pres = pw
          ? await pw.deleteByIdRaw(id, options)
          : { ok: true, value: false };
        if (fw) fw.deleteByIdRaw(id, options).catch(() => {});
        return pres;
      },
      clearAll: async () => {
        const pres = pw?.clearAll
          ? await pw.clearAll()
          : { ok: true, value: undefined };
        if (fw?.clearAll) fw.clearAll().catch(() => {});
        return pres;
      },
      upsertPrecomputedRaw: async (id, text, vector, metadata, options) => {
        const pres = pw?.upsertPrecomputedRaw
          ? await pw.upsertPrecomputedRaw(id, text, vector, metadata, options)
          : pw
            ? await pw.upsertRaw(id, text, metadata, options)
            : { ok: true, value: undefined };
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
//# sourceMappingURL=fallback-rag.js.map
