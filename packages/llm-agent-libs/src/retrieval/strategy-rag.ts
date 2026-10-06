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

/** True when `rag` is `target` or decorates it (through `IRagDecorator.inner`). */
function decorates(rag: IRag, target: IRag): boolean {
  let cur: IRag | undefined = rag;
  for (let depth = 0; cur && depth < 16; depth++) {
    if (cur === target) return true;
    cur = isRagDecorator(cur) ? cur.inner : undefined;
  }
  return false;
}

/**
 * The store an agent queries for one of its built-in slots (`tools`, `history`).
 * The agent's OWN store always has priority: the projected entry is used only
 * when it carries a retrieval strategy and decorates `own` (so a decorator the
 * projection carries is kept); otherwise `ownWithStrategy` — `own`
 * with the explicit strategy applied once by the caller, or `own` itself. A
 * projected entry over another agent's store (a worker sharing its parent's
 * registry) never wins. Internal; not re-exported.
 */
export function ownBuiltInStore(
  own: IRag,
  ownWithStrategy: IRag,
  projected: IRag | undefined,
): IRag {
  return projected &&
    hasRetrievalStrategy(projected) &&
    decorates(projected, own)
    ? projected
    : ownWithStrategy;
}
