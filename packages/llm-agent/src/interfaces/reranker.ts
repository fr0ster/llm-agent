import type { CallOptions, RagError, RagResult, Result } from './types.js';

export interface IReranker {
  rerank(
    query: string,
    results: RagResult[],
    options?: CallOptions,
  ): Promise<Result<RagResult[], RagError>>;
  /**
   * Cheap liveness check (spec §17.43 D97): `true` when the reranker can rerank,
   * `false` or `ok: false` when it cannot. Optional: without it, the agent's
   * health probe makes one minimal `rerank` call over one short candidate.
   */
  healthCheck?(options?: CallOptions): Promise<Result<boolean, RagError>>;
}
