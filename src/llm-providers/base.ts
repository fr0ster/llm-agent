/**
 * Base interface for LLM providers
 */

import type { Message, LLMResponse, LLMProviderConfig } from '../types.js';

export interface LLMProvider {
  /**
   * Send a chat message and get response
   */
  chat(messages: Message[]): Promise<LLMResponse>;

  /**
   * Stream chat response (optional, for future implementation)
   */
  streamChat?(messages: Message[]): AsyncGenerator<LLMResponse>;

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

  abstract chat(messages: Message[]): Promise<LLMResponse>;

  /**
   * Validate configuration
   */
  protected validateConfig(): void {
    if (!this.config.apiKey) {
      throw new Error('API key is required');
    }
  }
}

