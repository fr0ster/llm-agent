import type { IEmbedder } from '../interfaces/embedder.js';
import type { IRag } from '../interfaces/rag.js';
import {
  type CallOptions,
  RagError,
  type RagMetadata,
  type RagResult,
  type Result,
} from '../interfaces/types.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface VectorRagConfig {
  /** Embedder used to convert text → dense vector. */
  embedder: IEmbedder;
  /** Cosine similarity threshold for dedup. Default: 0.92 */
  dedupThreshold?: number;
  /** Namespace for this store. Records with a different namespace are invisible. */
  namespace?: string;
}

// ---------------------------------------------------------------------------
// Internal record
// ---------------------------------------------------------------------------

interface StoredRecord {
  text: string;
  vector: number[];
  metadata: RagMetadata;
}

// ---------------------------------------------------------------------------
// VectorRag — embedder-agnostic vector store
// ---------------------------------------------------------------------------

export class VectorRag implements IRag {
  private records: StoredRecord[] = [];
  private readonly embedder: IEmbedder;
  private readonly dedupThreshold: number;
  private readonly namespace?: string;

  constructor(config: VectorRagConfig) {
    this.embedder = config.embedder;
    this.dedupThreshold = config.dedupThreshold ?? 0.92;
    this.namespace = config.namespace;
  }

  /**
   * Verify the backing embedder is reachable. Non-fatal — callers should log
   * a warning on failure rather than crashing.
   */
  async checkHealth(): Promise<void> {
    if (this.embedder.checkHealth) {
      await this.embedder.checkHealth();
    } else {
      await this.embedder.embed('health');
    }
  }

  // -------------------------------------------------------------------------
  // IRag
  // -------------------------------------------------------------------------

  async upsert(
    text: string,
    metadata: RagMetadata,
    options?: CallOptions,
  ): Promise<Result<void, RagError>> {
    if (options?.signal?.aborted) {
      return { ok: false, error: new RagError('Aborted', 'ABORTED') };
    }

    // Namespace filter: skip records belonging to a different namespace
    if (
      this.namespace !== undefined &&
      metadata.namespace !== undefined &&
      metadata.namespace !== this.namespace
    ) {
      return { ok: true, value: undefined };
    }

    try {
      const vector = await this.embedder.embed(text);

      // Dedup: update existing record if cosine similarity >= threshold
      for (const rec of this.records) {
        if (this._cosine(rec.vector, vector) >= this.dedupThreshold) {
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
      const vector = await this.embedder.embed(text);

      const scored = this.records
        .filter((r) => {
          if (r.metadata.ttl !== undefined && r.metadata.ttl < nowSecs) return false;
          if (
            this.namespace !== undefined &&
            r.metadata.namespace !== undefined &&
            r.metadata.namespace !== this.namespace
          ) {
            return false;
          }
          return true;
        })
        .map((r) => ({
          text: r.text,
          metadata: r.metadata,
          score: this._cosine(vector, r.vector),
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, k);

      return { ok: true, value: scored };
    } catch (err) {
      if (err instanceof RagError) return { ok: false, error: err };
      return { ok: false, error: new RagError(String(err), 'QUERY_ERROR') };
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _cosine(a: number[], b: number[]): number {
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
}
