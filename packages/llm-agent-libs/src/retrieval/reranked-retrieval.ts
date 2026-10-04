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

/** Cap on a thrown error's text in the step: enough for a reason, never a dump. */
const MAX_THROWN_MESSAGE = 500;

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
  let message: string;
  try {
    const r = await reranker.rerank(query.text, candidates, options);
    if (r.ok) return { ok: true, value: r.value.slice(0, k) };
    code = r.error.code;
    message = r.error.message;
  } catch (err) {
    code = 'RERANK_THROWN';
    message = String(err).slice(0, MAX_THROWN_MESSAGE);
  }
  options?.sessionLogger?.logStep('retrieval_rerank_error', {
    store: storeName,
    strategy: name,
    code,
    message,
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

/**
 * The store's first `maxCandidates` (configured, never assumed) → rerank all → top-k.
 * Fetches at least `k`, so a `maxCandidates` below `k` never shrinks the result.
 */
export class RerankAllRetrieval implements IRetrievalStrategy {
  readonly name = 'rerank-all';

  constructor(
    private readonly reranker: IReranker,
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
