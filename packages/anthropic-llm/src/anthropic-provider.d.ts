/**
 * Anthropic (Claude) LLM Provider
 */
import type { IModelInfo, LLMCallOptions, LLMProviderConfig, LLMResponse, Message } from '@mcp-abap-adt/llm-agent';
import { BaseLLMProvider } from '@mcp-abap-adt/llm-agent';
import { type AxiosInstance } from 'axios';
export interface AnthropicConfig extends LLMProviderConfig {
    model?: string;
    temperature?: number;
    maxTokens?: number;
}
export declare class AnthropicProvider extends BaseLLMProvider<AnthropicConfig> {
    readonly client: AxiosInstance;
    readonly model: string;
    constructor(config: AnthropicConfig);
    chat(messages: Message[], tools?: unknown[], options?: LLMCallOptions): Promise<LLMResponse>;
    streamChat(messages: Message[], tools?: unknown[], options?: LLMCallOptions): AsyncIterable<LLMResponse>;
    getModels(): Promise<IModelInfo[]>;
    getEmbeddingModels(): Promise<IModelInfo[]>;
    /**
     * Format messages for Anthropic API
     */
    private formatMessages;
}
//# sourceMappingURL=anthropic-provider.d.ts.map