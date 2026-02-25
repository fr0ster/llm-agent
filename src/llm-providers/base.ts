/**
 * Base interface for LLM providers
 */

import type { LLMProviderConfig, LLMResponse, Message } from '../types.js';

export interface LLMProvider {
  /**
   * Send a chat message and get response
   */
  chat(messages: Message[], tools?: any[]): Promise<LLMResponse>;

  /**
   * Stream chat response
   */
  streamChat(messages: Message[], tools?: any[]): AsyncIterable<LLMResponse>;

  /**
   * Get available models
   */
  getModels?(): Promise<string[]>;
}

export abstract class BaseLLMProvider implements LLMProvider {
  protected config: LLMProviderConfig;

  constructor(config: LLMProviderConfig) {
    this.config = config;
  }

  abstract chat(messages: Message[], tools?: any[]): Promise<LLMResponse>;

  abstract streamChat(messages: Message[], tools?: any[]): AsyncIterable<LLMResponse>;

  /**
   * Validate configuration
   */
  protected validateConfig(): void {
    if (!this.config.apiKey) {
      throw new Error('API key is required');
    }
  }
}
