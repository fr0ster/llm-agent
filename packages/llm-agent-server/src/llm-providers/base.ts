/**
 * Base interface for LLM providers
 */

import type {
  IModelInfo,
  LLMCallOptions,
  LLMProviderConfig,
  LLMResponse,
  Message,
} from '@mcp-abap-adt/llm-agent';

export interface LLMProvider {
  /**
   * Send a chat message and get response
   */
  chat(
    messages: Message[],
    tools?: unknown[],
    options?: LLMCallOptions,
  ): Promise<LLMResponse>;

  /**
   * Stream chat response
   */
  streamChat(
    messages: Message[],
    tools?: unknown[],
    options?: LLMCallOptions,
  ): AsyncIterable<LLMResponse>;

  /**
   * Get available models
   */
  getModels?(): Promise<string[] | IModelInfo[]>;

  /**
   * Get embedding models. Best-effort; may return empty array.
   */
  getEmbeddingModels?(): Promise<string[] | IModelInfo[]>;
}

export abstract class BaseLLMProvider<
  C extends LLMProviderConfig = LLMProviderConfig,
> implements LLMProvider
{
  readonly config: C;

  constructor(config: C) {
    this.config = config;
  }

  abstract chat(
    messages: Message[],
    tools?: unknown[],
    options?: LLMCallOptions,
  ): Promise<LLMResponse>;

  abstract streamChat(
    messages: Message[],
    tools?: unknown[],
    options?: LLMCallOptions,
  ): AsyncIterable<LLMResponse>;

  /**
   * Validate configuration
   */
  protected validateConfig(): void {
    if (!this.config.apiKey) {
      throw new Error('API key is required');
    }
  }
}
