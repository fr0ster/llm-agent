/**
 * DeepSeek LLM Provider — extends OpenAI (DeepSeek uses OpenAI-compatible API).
 */
import type { IModelInfo, LLMProviderConfig, Message } from '@mcp-abap-adt/llm-agent';
import { OpenAIProvider } from '@mcp-abap-adt/openai-llm';
export interface DeepSeekConfig extends LLMProviderConfig {
    model?: string;
    temperature?: number;
    maxTokens?: number;
}
export declare class DeepSeekProvider extends OpenAIProvider {
    protected readonly providerName: string;
    constructor(config: DeepSeekConfig);
    /**
     * DeepSeek always uses max_tokens (no gpt-5/o1/o3 distinction).
     */
    protected getTokenLimitParam(_model: string, maxTokens: number): Record<string, number>;
    getEmbeddingModels(): Promise<IModelInfo[]>;
    /**
     * Stricter formatMessages — tracks known tool_call_ids and drops orphans.
     */
    protected formatMessages(messages: Message[]): Array<Record<string, unknown>>;
}
//# sourceMappingURL=deepseek-provider.d.ts.map