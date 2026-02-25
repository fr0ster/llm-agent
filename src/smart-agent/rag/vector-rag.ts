import type { IEmbedder, IRag } from '../interfaces/rag.js';
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
  /** Weight for vector search (0..1). Default: 0.7 */
  vectorWeight?: number;
  /** Weight for keyword search (0..1). Default: 0.3 */
  keywordWeight?: number;
}

export class VectorRag implements IRag {
  private records: StoredRecord[] = [];
  private readonly dedupThreshold: number;
  private readonly namespace?: string;
  private readonly vectorWeight: number;
  private readonly keywordWeight: number;

  constructor(
    private readonly embedder: IEmbedder,
    config: VectorRagConfig = {},
  ) {
    this.dedupThreshold = config.dedupThreshold ?? 0.92;
    this.namespace = config.namespace;
    this.vectorWeight = config.vectorWeight ?? 0.7;
    this.keywordWeight = config.keywordWeight ?? 0.3;
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

  /**
   * BM25 Lexical Scorer.
   * Proper term weighting based on Inverse Document Frequency.
   */
  private bm25Score(query: string, text: string): number {
    const tokenize = (s: string) =>
      s
        .toLowerCase()
        .split(/[^a-z0-9]/)
        .filter((t) => t.length > 1);
    const queryTokens = tokenize(query);
    const docTokens = tokenize(text);

    if (queryTokens.length === 0 || docTokens.length === 0) return 0;

    // Corpus stats
    const avgDocLength =
      this.records.reduce((acc, r) => acc + tokenize(r.text).length, 0) /
      (this.records.length || 1);
    const k1 = 1.2;
    const b = 0.75;

    let score = 0;
    for (const token of new Set(queryTokens)) {
      // Document frequency
      const df = this.records.filter((r) =>
        tokenize(r.text).includes(token),
      ).length;
      const idf = Math.log((this.records.length - df + 0.5) / (df + 0.5) + 1);

      // Term frequency in current doc
      const tf = docTokens.filter((t) => t === token).length;

      const tfScored =
        (tf * (k1 + 1)) /
        (tf + k1 * (1 - b + b * (docTokens.length / avgDocLength)));
      score += idf * tfScored;
    }

    // Normalize to [0, 1] range (rough approximation for fusion)
    return Math.min(score / 5, 1.0);
  }

  async upsert(
    text: string,
    metadata: RagMetadata,
    options?: CallOptions,
  ): Promise<Result<void, RagError>> {
    // ... (abort check and namespace check same as before)
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
      const queryVector = await this.embedder.embed(text, options);
      const targetNamespace = options?.ragFilter?.namespace;

      const scored = this.records
        .filter((r) => {
          if (r.metadata.ttl !== undefined && r.metadata.ttl < nowSecs)
            return false;

          // Apply dynamic filter from CallOptions
          if (
            targetNamespace !== undefined &&
            r.metadata.namespace !== targetNamespace
          )
            return false;

          if (
            this.namespace !== undefined &&
            r.metadata.namespace !== undefined &&
            r.metadata.namespace !== this.namespace
          )
            return false;
          return true;
        })
        .map((r) => {
          const vScore = this.cosine(queryVector, r.vector);
          const lScore = this.bm25Score(text, r.text);

          // Hybrid Fusion: Weighted Sum
          const combinedScore =
            vScore * this.vectorWeight + lScore * this.keywordWeight;

          return {
            text: r.text,
            metadata: r.metadata,
            score: combinedScore,
          };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, k);

      return { ok: true, value: scored };
    } catch (err) {
      if (err instanceof RagError) return { ok: false, error: err };
      return { ok: false, error: new RagError(String(err), 'QUERY_ERROR') };
    }
  }

  async healthCheck(options?: CallOptions): Promise<Result<void, RagError>> {
    try {
      await this.embedder.embed('ping', options);
      return { ok: true, value: undefined };
    } catch (err) {
      return {
        ok: false,
        error: new RagError(
          `RAG health check failed: ${String(err)}`,
          'HEALTH_CHECK_ERROR',
        ),
      };
    }
  }
}
