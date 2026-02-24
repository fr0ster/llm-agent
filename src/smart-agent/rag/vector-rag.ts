import type { IRag, IEmbedder } from '../interfaces/rag.js';
import {
  type CallOptions,
  RagError,
  type RagMetadata,
  type RagResult,
  type Result,
} from '../interfaces/types.js';

interface StoredRecord {
  text: string;
  vector: number[];
  metadata: RagMetadata;
}

export interface VectorRagConfig {
  /** Cosine similarity threshold for dedup. Default: 0.92 */
  dedupThreshold?: number;
  /** Namespace for this store. */
  namespace?: string;
}

export class VectorRag implements IRag {
  private records: StoredRecord[] = [];
  private readonly dedupThreshold: number;
  private readonly namespace?: string;

  constructor(
    private readonly embedder: IEmbedder,
    config: VectorRagConfig = {}
  ) {
    this.dedupThreshold = config.dedupThreshold ?? 0.92;
    this.namespace = config.namespace;
  }

  private cosine(a: number[], b: number[]): number {
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] ** 2;
      nb += b[i] ** 2;
    }
    return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
  }

  async upsert(
    text: string,
    metadata: RagMetadata,
    options?: CallOptions,
  ): Promise<Result<void, RagError>> {
    if (options?.signal?.aborted) {
      return { ok: false, error: new RagError('Aborted', 'ABORTED') };
    }

    if (
      this.namespace !== undefined &&
      metadata.namespace !== undefined &&
      metadata.namespace !== this.namespace
    ) {
      return { ok: true, value: undefined };
    }

    try {
      const vector = await this.embedder.embed(text, options);

      for (const rec of this.records) {
        if (this.cosine(rec.vector, vector) >= this.dedupThreshold) {
          rec.text = text;
          rec.vector = vector;
          rec.metadata = { ...rec.metadata, ...metadata };
          return { ok: true, value: undefined };
        }
      }

      this.records.push({ text, vector, metadata });
      return { ok: true, value: undefined };
    } catch (err) {
      if (err instanceof RagError) return { ok: false, error: err };
      return { ok: false, error: new RagError(String(err), 'UPSERT_ERROR') };
    }
  }

  async query(
    text: string,
    k: number,
    options?: CallOptions,
  ): Promise<Result<RagResult[], RagError>> {
    if (options?.signal?.aborted) {
      return { ok: false, error: new RagError('Aborted', 'ABORTED') };
    }

    try {
      const nowSecs = Date.now() / 1000;
      const vector = await this.embedder.embed(text, options);

      const scored = this.records
        .filter((r) => {
          if (r.metadata.ttl !== undefined && r.metadata.ttl < nowSecs)
            return false;
          if (
            this.namespace !== undefined &&
            r.metadata.namespace !== undefined &&
            r.metadata.namespace !== this.namespace
          )
            return false;
          return true;
        })
        .map((r) => ({
          text: r.text,
          metadata: r.metadata,
          score: this.cosine(vector, r.vector),
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, k);

      return { ok: true, value: scored };
    } catch (err) {
      if (err instanceof RagError) return { ok: false, error: err };
      return { ok: false, error: new RagError(String(err), 'QUERY_ERROR') };
    }
  }
}
