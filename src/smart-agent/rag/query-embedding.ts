import type { IQueryEmbedding } from '../interfaces/query-embedding.js';
import type { IEmbedder } from '../interfaces/rag.js';
import type { CallOptions } from '../interfaces/types.js';
import { RagError } from '../interfaces/types.js';

/**
 * Lazy, memoized query embedding.
 *
 * First `toVector()` call triggers the real embed; all subsequent
 * (or concurrent) calls return the same promise.
 */
export class QueryEmbedding implements IQueryEmbedding {
  readonly text: string;
  private _vector: Promise<number[]> | null = null;

  constructor(
    text: string,
    private readonly embedder: IEmbedder,
    private readonly options?: CallOptions,
  ) {
    this.text = text;
  }

  toVector(): Promise<number[]> {
    this._vector ??= this.embedder.embed(this.text, this.options);
    return this._vector;
  }
}

/**
 * Text-only embedding for stores that don't need vectors (e.g. InMemoryRag).
 * Throws on `toVector()` — only `.text` is usable.
 */
export class TextOnlyEmbedding implements IQueryEmbedding {
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
  toVector(): Promise<number[]> {
    return Promise.reject(
      new RagError(
        'No embedder configured — cannot vectorize query',
        'EMBED_ERROR',
      ),
    );
  }
}

/**
 * Decorator: tries the inner embedding first; on failure falls back
 * to the supplied embedder.  Result is memoized so concurrent callers
 * share one promise — same contract as {@link QueryEmbedding}.
 */
export class FallbackQueryEmbedding implements IQueryEmbedding {
  private _vector: Promise<number[]> | null = null;

  constructor(
    private readonly inner: IQueryEmbedding,
    private readonly fallback: IEmbedder,
  ) {}

  get text(): string {
    return this.inner.text;
  }

  toVector(): Promise<number[]> {
    this._vector ??= this.inner
      .toVector()
      .catch(() => this.fallback.embed(this.text));
    return this._vector;
  }
}
