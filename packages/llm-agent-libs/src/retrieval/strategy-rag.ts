import {
  type CallOptions,
  type IQueryEmbedding,
  type IRag,
  type IRagBackendWriter,
  type IRagDecorator,
  type IRetrievalStrategy,
  isRagDecorator,
  type RagError,
  type RagResult,
  type Result,
} from '@mcp-abap-adt/llm-agent';

const BRAND = Symbol.for('@mcp-abap-adt/strategy-rag');

/** IRag decorator: `query` goes through the strategy, everything else to `inner` (spec §13.3). */
export class StrategyRag implements IRag, IRagDecorator {
  readonly [BRAND] = true;
  constructor(
    readonly inner: IRag,
    readonly strategy: IRetrievalStrategy,
  ) {}
  query(
    embedding: IQueryEmbedding,
    k: number,
    options?: CallOptions,
  ): Promise<Result<RagResult[], RagError>> {
    return this.strategy.retrieve(this.inner, embedding, k, options);
  }
  healthCheck(options?: CallOptions): Promise<Result<void, RagError>> {
    return this.inner.healthCheck(options);
  }
  getById(
    id: string,
    options?: CallOptions,
  ): Promise<Result<RagResult | null, RagError>> {
    return this.inner.getById(id, options);
  }
  writer(): IRagBackendWriter | undefined {
    return this.inner.writer?.();
  }
}

/** True when `rag`, or any store it decorates, carries a retrieval strategy. */
export function hasRetrievalStrategy(rag: IRag): boolean {
  let cur: IRag | undefined = rag;
  for (let depth = 0; cur && depth < 16; depth++) {
    if ((cur as { [BRAND]?: boolean })[BRAND]) return true;
    cur = isRagDecorator(cur) ? cur.inner : undefined;
  }
  return false;
}

/** Wrap an explicitly configured store (embedding included); idempotent through decorators. */
export function applyRetrievalStrategy(
  rag: IRag,
  strategy: IRetrievalStrategy,
): IRag {
  return hasRetrievalStrategy(rag) ? rag : new StrategyRag(rag, strategy);
}
