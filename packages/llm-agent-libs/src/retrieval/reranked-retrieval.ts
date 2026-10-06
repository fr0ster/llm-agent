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
import { assertPositiveInteger } from '../util/assert-positive-integer.js';
import { callReranker, rerankFailedError } from './rerank-call.js';

async function rerankOrError(
  name: string,
  storeName: string | undefined,
  reranker: IReranker,
  query: IQueryEmbedding,
  candidates: RagResult[],
  k: number,
  options?: CallOptions,
): Promise<Result<RagResult[], RagError>> {
  const r = await callReranker(reranker, query.text, candidates, options);
  if (r.ok) return { ok: true, value: r.value.slice(0, k) };
  options?.sessionLogger?.logStep('retrieval_rerank_error', {
    store: storeName,
    strategy: name,
    code: r.failure.code,
    message: r.failure.message,
  });
  // Spec §9.3, D71: no embedding-order fallback.
  return { ok: false, error: rerankFailedError(r.failure) };
}

/** Embedding top (k × overfetch) → rerank → top-k. */
export class RerankedRetrieval implements IRetrievalStrategy {
  readonly name = 'rerank';
  private readonly overfetch: number;

  constructor(
    /** Read-only, so the agent's health probe finds it (spec §17.43 D97). */
    readonly reranker: IReranker,
    private readonly opts: { overfetch?: number; storeName?: string } = {},
  ) {
    this.overfetch = opts.overfetch ?? 2;
    assertPositiveInteger('RerankedRetrieval', 'overfetch', this.overfetch);
  }

  async retrieve(
    store: IRag,
    query: IQueryEmbedding,
    k: number,
    options?: CallOptions,
  ): Promise<Result<RagResult[], RagError>> {
    const cand = await store.query(query, k * this.overfetch, options);
    if (!cand.ok) return cand;
    return rerankOrError(
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

/**
 * The store's first `maxCandidates` (configured, never assumed) → rerank all → top-k.
 * Fetches at least `k`, so a `maxCandidates` below `k` never shrinks the result.
 */
export class RerankAllRetrieval implements IRetrievalStrategy {
  readonly name = 'rerank-all';

  constructor(
    /** Read-only, so the agent's health probe finds it (spec §17.43 D97). */
    readonly reranker: IReranker,
    private readonly opts: { maxCandidates: number; storeName?: string },
  ) {
    assertPositiveInteger(
      'RerankAllRetrieval',
      'maxCandidates',
      opts.maxCandidates,
    );
  }

  async retrieve(
    store: IRag,
    query: IQueryEmbedding,
    k: number,
    options?: CallOptions,
  ): Promise<Result<RagResult[], RagError>> {
    const cand = await store.query(
      query,
      Math.max(k, this.opts.maxCandidates),
      options,
    );
    if (!cand.ok) return cand;
    return rerankOrError(
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
