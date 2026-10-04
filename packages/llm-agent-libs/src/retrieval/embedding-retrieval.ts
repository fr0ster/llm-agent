import type {
  CallOptions,
  IQueryEmbedding,
  IRag,
  IRetrievalStrategy,
  RagError,
  RagResult,
  Result,
} from '@mcp-abap-adt/llm-agent';

/** Today's behaviour: the store's own (embedding) ranking. */
export class EmbeddingRetrieval implements IRetrievalStrategy {
  readonly name = 'embedding';
  retrieve(
    store: IRag,
    query: IQueryEmbedding,
    k: number,
    options?: CallOptions,
  ): Promise<Result<RagResult[], RagError>> {
    return store.query(query, k, options);
  }
}
