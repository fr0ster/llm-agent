/**
 * LlmAdapter — wraps a bridge object implementing callWithTools/streamWithTools as ILlm.
 */
import type { BaseAgentLlmBridge, ILlm, IModelFilter, IModelInfo, IModelProvider, Message } from '@mcp-abap-adt/llm-agent';
import { type CallOptions, LlmError, type LlmResponse, type LlmStreamChunk, type LlmTool, type Result } from '@mcp-abap-adt/llm-agent';
export type { BaseAgentLlmBridge };
export interface AgentCallOptions {
    temperature?: number;
    maxTokens?: number;
    topP?: number;
    stop?: string[];
}
export interface LlmAdapterProviderInfo {
    model: string;
    getModels?(): Promise<string[] | IModelInfo[]>;
    getEmbeddingModels?(): Promise<string[] | IModelInfo[]>;
}
export declare class LlmAdapter implements ILlm, IModelProvider {
    private readonly agent;
    private readonly provider?;
    constructor(agent: BaseAgentLlmBridge, provider?: LlmAdapterProviderInfo | undefined);
    getModel(): string;
    get model(): string;
    getModels(options?: CallOptions & IModelFilter): Promise<Result<IModelInfo[], LlmError>>;
    getEmbeddingModels(options?: CallOptions): Promise<Result<IModelInfo[], LlmError>>;
    chat(messages: Message[], tools?: LlmTool[], options?: CallOptions): Promise<Result<LlmResponse, LlmError>>;
    streamChat(messages: Message[], tools?: LlmTool[], options?: CallOptions): AsyncIterable<Result<LlmStreamChunk, LlmError>>;
    healthCheck(options?: CallOptions): Promise<Result<boolean, LlmError>>;
}
//# sourceMappingURL=llm-adapter.d.ts.map