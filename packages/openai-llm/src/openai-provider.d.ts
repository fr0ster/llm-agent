/**
 * OpenAI LLM Provider
 */
import type {
  IModelInfo,
  LLMCallOptions,
  LLMProviderConfig,
  LLMResponse,
  Message,
} from '@mcp-abap-adt/llm-agent';
import { BaseLLMProvider } from '@mcp-abap-adt/llm-agent';
import { type AxiosInstance } from 'axios';
export interface OpenAIConfig extends LLMProviderConfig {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  organization?: string;
  project?: string;
}
export declare class OpenAIProvider extends BaseLLMProvider<OpenAIConfig> {
  readonly client: AxiosInstance;
  readonly model: string;
  protected readonly providerName: string;
  constructor(config: OpenAIConfig);
  chat(
    messages: Message[],
    tools?: unknown[],
    options?: LLMCallOptions,
  ): Promise<LLMResponse>;
  streamChat(
    messages: Message[],
    tools?: unknown[],
    options?: LLMCallOptions,
  ): AsyncIterable<LLMResponse>;
  getModels(): Promise<IModelInfo[]>;
  getEmbeddingModels(): Promise<IModelInfo[]>;
  /**
   * Return the appropriate token limit parameter for the model.
   * Newer models (o1, o3, gpt-5+) require max_completion_tokens;
   * legacy models use max_tokens.
   */
  protected getTokenLimitParam(
    model: string,
    maxTokens: number,
  ): Record<string, number>;
  /**
   * Format messages for OpenAI API with strict protocol enforcement.
   */
  protected formatMessages(messages: Message[]): Array<Record<string, unknown>>;
}
//# sourceMappingURL=openai-provider.d.ts.map
