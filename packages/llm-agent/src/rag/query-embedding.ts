import type { IQueryEmbedding } from '../interfaces/query-embedding.js';
import type { IEmbedResult, IQueryEmbedder } from '../interfaces/rag.js';
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
  private _result: Promise<IEmbedResult> | null = null;

  constructor(
    text: string,
    private readonly embedder: IQueryEmbedder,
    private readonly options?: CallOptions,
  ) {
    this.text = text;
  }

  private _getResult(): Promise<IEmbedResult> {
    this._result ??= this.embedder.embedQuery(this.text, this.options);
    return this._result;
  }

  toVector(): Promise<number[]> {
    return this._getResult().then((r) => r.vector);
  }

  getUsage(): Promise<IEmbedResult['usage']> {
    return this._getResult().then((r) => r.usage);
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
 * Decorator: a {@link TextOnlyEmbedding} (no caller embedder) is embedded with
 * the supplied store embedder; any other inner embedding is used as is and its
 * failure propagates.  Result is memoized so concurrent callers share one
 * promise — same contract as {@link QueryEmbedding}.
 */
export class FallbackQueryEmbedding implements IQueryEmbedding {
  private _vector: Promise<number[]> | null = null;

  constructor(
    private readonly inner: IQueryEmbedding,
    private readonly fallback: IQueryEmbedder,
  ) {}

  get text(): string {
    return this.inner.text;
  }

  toVector(): Promise<number[]> {
    // Spec §10.5.4 R1 (D73): the store's embedder stands in ONLY for a caller with
    // no embedder (TextOnlyEmbedding — an absent capability). A real embedder that
    // failed is an error, never re-embedded behind the caller's back.
    this._vector ??=
      this.inner instanceof TextOnlyEmbedding
        ? this.fallback.embedQuery(this.text).then((r) => r.vector)
        : this.inner.toVector();
    return this._vector;
  }
}
