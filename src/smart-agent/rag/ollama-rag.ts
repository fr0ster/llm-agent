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

export interface OllamaRagConfig {
  /** Default: 'http://localhost:11434' */
  ollamaUrl?: string;
  /** Default: 'nomic-embed-text' */
  model?: string;
  /** Cosine similarity threshold for dedup. Default: 0.92 */
  dedupThreshold?: number;
  /** Namespace for this store. */
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
// OllamaRag
// ---------------------------------------------------------------------------

export class OllamaRag implements IRag {
  private records: StoredRecord[] = [];
  private readonly ollamaUrl: string;
  private readonly model: string;
  private readonly dedupThreshold: number;
  private readonly namespace?: string;

  constructor(config: OllamaRagConfig = {}) {
    this.ollamaUrl = config.ollamaUrl ?? 'http://localhost:11434';
    this.model = config.model ?? 'nomic-embed-text';
    this.dedupThreshold = config.dedupThreshold ?? 0.92;
    this.namespace = config.namespace;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async embed(text: string): Promise<number[]> {
    const url = `${this.ollamaUrl}/api/embeddings`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, prompt: text }),
    });
    if (!res.ok) {
      throw new RagError(
        `Ollama embed error: HTTP ${res.status}`,
        'EMBED_ERROR',
      );
    }
    const json = (await res.json()) as { embedding: number[] };
    return json.embedding;
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

  // -------------------------------------------------------------------------
  // IRag implementation
  // -------------------------------------------------------------------------

  async upsert(
    text: string,
    metadata: RagMetadata,
    options?: CallOptions,
  ): Promise<Result<void, RagError>> {
    if (options?.signal?.aborted) {
      return { ok: false, error: new RagError('Aborted', 'ABORTED') };
    }

    // Namespace filter: skip if this store has a namespace and the record's
    // namespace differs (undefined metadata.namespace is always accepted).
    if (
      this.namespace !== undefined &&
      metadata.namespace !== undefined &&
      metadata.namespace !== this.namespace
    ) {
      return { ok: true, value: undefined };
    }

    try {
      const vector = await this.embed(text);

      // Dedup: update existing record if cosine similarity >= threshold
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
      const vector = await this.embed(text);

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
