import { AsyncLocalStorage } from 'node:async_hooks';
import {
  type CallOptions,
  FallbackRag,
  type IQueryEmbedding,
  type IRag,
  type IRagCatalogUpdater,
  type IRagDecorator,
  type IRagFilteredDeleter,
  type IRagScanner,
  type IRetrievalEmbedder,
  type IRetrievalStrategy,
  isRagCatalogUpdater,
  isRagFilteredDeleter,
  isRagScanner,
  type RagError,
  type RagResult,
  type Result,
  ragDecoratorChain,
} from '@mcp-abap-adt/llm-agent';

const BRAND = Symbol.for('@mcp-abap-adt/strategy-rag');
const relocatedStrategies = new AsyncLocalStorage<ReadonlySet<IRag>>();

interface StoreEmbedding {
  readonly embedder?: IRetrievalEmbedder;
  readonly fragmentSizeChars?: number;
}

/** IRag decorator: `query` goes through the strategy, everything else to `inner` (spec §13.3). */
export class StrategyRag<Store extends IRag = IRag>
  implements IRag, IRagDecorator
{
  readonly [BRAND] = true;
  declare readonly list?: IRag['list'];
  declare readonly writer: Store['writer'];
  declare readonly scan?: IRagScanner['scan'];
  declare readonly deleteWhere?: IRagFilteredDeleter['deleteWhere'];
  declare readonly updateCollection?: IRagCatalogUpdater['updateCollection'];
  declare readonly embedder?: IRetrievalEmbedder;
  declare readonly fragmentSizeChars?: number;

  constructor(
    readonly inner: Store,
    readonly strategy: IRetrievalStrategy,
    private readonly relocated?: StrategyRag,
  ) {
    if (typeof inner.list === 'function') this.list = inner.list.bind(inner);
    if (typeof inner.writer === 'function')
      this.writer = inner.writer.bind(inner);
    if (isRagScanner(inner)) this.scan = inner.scan.bind(inner);
    if (isRagFilteredDeleter(inner))
      this.deleteWhere = inner.deleteWhere.bind(inner);
    if (isRagCatalogUpdater(inner)) {
      this.updateCollection = inner.updateCollection.bind(inner);
    }
    const { embedder, fragmentSizeChars } = inner as IRag & StoreEmbedding;
    if (embedder !== undefined) this.embedder = embedder;
    if (fragmentSizeChars !== undefined)
      this.fragmentSizeChars = fragmentSizeChars;
  }
  query(
    embedding: IQueryEmbedding,
    k: number,
    options?: CallOptions,
  ): Promise<Result<RagResult[], RagError>> {
    const active = relocatedStrategies.getStore();
    if (active?.has(this)) {
      return this.inner.query(embedding, k, options);
    }
    if (this.relocated) {
      const suppressed = new Set(active);
      for (
        let relocated: StrategyRag | undefined = this.relocated;
        relocated;
        relocated = relocated.relocated
      ) {
        suppressed.add(relocated);
      }
      return relocatedStrategies.run(suppressed, () =>
        this.strategy.retrieve(this.inner, embedding, k, options),
      );
    }
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
}

function isStrategyRag(rag: IRag): rag is StrategyRag {
  return (rag as Partial<StrategyRag>)[BRAND] === true;
}

/** True when `rag`, or any store it decorates, carries a retrieval strategy. */
export function hasRetrievalStrategy(rag: IRag): boolean {
  return ragDecoratorChain(rag).some(isStrategyRag);
}

/** Apply an explicit strategy or lift an existing one above fallback routing. */
export function applyRetrievalStrategy(
  rag: IRag,
  strategy?: IRetrievalStrategy,
): IRag {
  const chain = ragDecoratorChain(rag);
  const existing = chain.find(isStrategyRag);
  if (!existing) return strategy ? new StrategyRag(rag, strategy) : rag;
  const fallbackIndex = chain.findIndex(
    (store) => store instanceof FallbackRag,
  );
  if (fallbackIndex === -1 || fallbackIndex > chain.indexOf(existing))
    return rag;

  // Leave the routing chain intact and link to the previous wrapper so the
  // query can suppress every wrapper from earlier lifts.
  return new StrategyRag(rag, existing.strategy, existing);
}

/** True when `rag` is `target` or decorates it (through `IRagDecorator.inner`). */
function decorates(rag: IRag, target: IRag): boolean {
  return ragDecoratorChain(rag).includes(target);
}

/**
 * The store an agent queries for one of its built-in slots (`tools`, `history`).
 * The agent's OWN store always has priority: the projected entry is used only
 * when it carries a retrieval strategy and decorates `own` (so layers such as
 * the circuit-breaker fallback are kept); otherwise `ownWithStrategy` — `own`
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
