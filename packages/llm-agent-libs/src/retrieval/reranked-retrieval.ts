import type {
  CallOptions,
  IQueryEmbedding,
  IRag,
  IReranker,
  IRetrievalStrategy,
  RagError,
  RagResult,
  Result,
} from '@mcp-abap-adt/llm-agent';

async function rerankOrFallback(
  name: string,
  storeName: string | undefined,
  reranker: IReranker,
  query: IQueryEmbedding,
  candidates: RagResult[],
  k: number,
  options?: CallOptions,
): Promise<Result<RagResult[], RagError>> {
  let code: string;
  try {
    const r = await reranker.rerank(query.text, candidates, options);
    if (r.ok) return { ok: true, value: r.value.slice(0, k) };
    code = r.error.code;
  } catch {
    code = 'RERANK_THROWN';
  }
  options?.sessionLogger?.logStep('retrieval_rerank_error', {
    store: storeName,
    strategy: name,
    code,
  });
  return { ok: true, value: candidates.slice(0, k) };
}

/** Embedding top (k × overfetch) → rerank → top-k. */
export class RerankedRetrieval implements IRetrievalStrategy {
  readonly name = 'rerank';
  private readonly overfetch: number;

  constructor(
    private readonly reranker: IReranker,
    private readonly opts: { overfetch?: number; storeName?: string } = {},
  ) {
    this.overfetch = opts.overfetch ?? 2;
  }

  async retrieve(
    store: IRag,
    query: IQueryEmbedding,
    k: number,
    options?: CallOptions,
  ): Promise<Result<RagResult[], RagError>> {
    const cand = await store.query(query, k * this.overfetch, options);
    if (!cand.ok) return cand;
    return rerankOrFallback(
      this.name,
      this.opts.storeName,
      this.reranker,
      query,
      cand.value,
      k,
      options,
    );
  }
}

/** The store's first `maxCandidates` (configured, never assumed) → rerank all → top-k. */
export class RerankAllRetrieval implements IRetrievalStrategy {
  readonly name = 'rerank-all';

  constructor(
    private readonly reranker: IReranker,
    private readonly opts: { maxCandidates: number; storeName?: string },
  ) {}

  async retrieve(
    store: IRag,
    query: IQueryEmbedding,
    k: number,
    options?: CallOptions,
  ): Promise<Result<RagResult[], RagError>> {
    const cand = await store.query(query, this.opts.maxCandidates, options);
    if (!cand.ok) return cand;
    return rerankOrFallback(
      this.name,
      this.opts.storeName,
      this.reranker,
      query,
      cand.value,
      k,
      options,
    );
  }
}
