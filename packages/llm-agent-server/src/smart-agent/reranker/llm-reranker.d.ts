import type { ILlm } from '@mcp-abap-adt/llm-agent';
import { type CallOptions, RagError, type RagResult, type Result } from '@mcp-abap-adt/llm-agent';
import type { IReranker } from './types.js';
export declare class LlmReranker implements IReranker {
    private readonly llm;
    constructor(llm: ILlm);
    rerank(query: string, results: RagResult[], options?: CallOptions): Promise<Result<RagResult[], RagError>>;
    private _parseScores;
}
//# sourceMappingURL=llm-reranker.d.ts.map