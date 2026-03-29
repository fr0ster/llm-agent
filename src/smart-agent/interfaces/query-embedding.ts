/**
 * A query embedding that lazily computes and caches its vector.
 *
 * Implementations MUST guarantee that `toVector()` calls the underlying
 * embedder at most once — concurrent callers receive the same promise.
 */
export interface IQueryEmbedding {
  /** Original query text (for BM25/keyword fallback). */
  readonly text: string;
  /** Returns the embedding vector, computing it on first call. */
  toVector(): Promise<number[]>;
}
