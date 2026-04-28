import type { CallOptions, RagError, RagResult, Result } from './types.js';
export interface IReranker {
    rerank(query: string, results: RagResult[], options?: CallOptions): Promise<Result<RagResult[], RagError>>;
}
//# sourceMappingURL=reranker.d.ts.map