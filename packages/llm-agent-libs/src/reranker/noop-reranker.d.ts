import type { CallOptions, RagError, RagResult, Result } from '@mcp-abap-adt/llm-agent';
import type { IReranker } from './types.js';
export declare class NoopReranker implements IReranker {
    rerank(_query: string, results: RagResult[], _options?: CallOptions): Promise<Result<RagResult[], RagError>>;
}
//# sourceMappingURL=noop-reranker.d.ts.map