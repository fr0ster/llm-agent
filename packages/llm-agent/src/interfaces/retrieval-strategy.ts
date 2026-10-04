import type { IQueryEmbedding } from './query-embedding.js';
import type { IRag } from './rag.js';
import type { CallOptions, RagError, RagResult, Result } from './types.js';

/**
 * How a store turns a query into its top-k results — the consumer's choice,
 * per store (spec §13.2). Built-ins: embedding / rerank / rerank-all.
 */
export interface IRetrievalStrategy {
  readonly name: string;
  retrieve(
    store: IRag,
    query: IQueryEmbedding,
    k: number,
    options?: CallOptions,
  ): Promise<Result<RagResult[], RagError>>;
}

/** Optional capability: a store that wraps another exposes it (spec §13.3). */
export interface IRagDecorator {
  readonly inner: IRag;
}

export function isRagDecorator(rag: IRag): rag is IRag & IRagDecorator {
  const inner = (rag as Partial<IRagDecorator>).inner;
  return (
    typeof inner === 'object' &&
    inner !== null &&
    typeof inner.query === 'function'
  );
}
