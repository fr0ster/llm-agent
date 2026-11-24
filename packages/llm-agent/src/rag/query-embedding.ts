import { toEmbeddingError } from '../errors/rag-error.js';
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
    this._result ??= this.embed();
    return this._result;
  }

  private async embed(): Promise<IEmbedResult> {
    try {
      return await this.embedder.embedQuery(this.text, {
        ...this.options,
        preserveEmbeddingInput: true,
        usage: this.options?.usage?.with({ role: 'embedding' }),
      });
    } catch (error) {
      throw toEmbeddingError(error);
    }
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

/** @deprecated Use the original query embedding directly. Failures propagate. */
export class FallbackQueryEmbedding implements IQueryEmbedding {
  private vector: Promise<number[]> | null = null;

  constructor(
    private readonly inner: IQueryEmbedding,
    _fallback: IQueryEmbedder,
    _options?: CallOptions,
  ) {}

  get text(): string {
    return this.inner.text;
  }

  toVector(): Promise<number[]> {
    this.vector ??= this.embed();
    return this.vector;
  }

  private async embed(): Promise<number[]> {
    try {
      return await this.inner.toVector();
    } catch (error) {
      throw toEmbeddingError(error);
    }
  }
}
