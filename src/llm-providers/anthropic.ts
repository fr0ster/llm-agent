/**
 * Anthropic (Claude) LLM Provider
 */

import axios, { type AxiosInstance } from 'axios';
import type { LLMProviderConfig, LLMResponse, Message } from '../types.js';
import { getErrorMessage, getNestedApiErrorMessage } from '../utils/errors.js';
import { BaseLLMProvider } from './base.js';

export interface AnthropicConfig extends LLMProviderConfig {
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export class AnthropicProvider extends BaseLLMProvider {
  private client: AxiosInstance;
  private model: string;
  private providerConfig: AnthropicConfig;

  constructor(config: AnthropicConfig) {
    super(config);
    this.validateConfig();
    this.providerConfig = config;

    this.model = config.model || 'claude-3-5-sonnet-20241022';

    this.client = axios.create({
      baseURL: config.baseURL || 'https://api.anthropic.com/v1',
      headers: {
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
    });
  }

  async chat(messages: Message[]): Promise<LLMResponse> {
    try {
      // Anthropic API uses different message format
      const systemMessage = messages.find((m) => m.role === 'system');
      const conversationMessages = messages.filter((m) => m.role !== 'system');

      const requestBody: {
        model: string;
        messages: Array<{ role: 'assistant' | 'user'; content: string }>;
        max_tokens: number;
        temperature: number;
        system?: string;
      } = {
        model: this.model,
        messages: this.formatMessages(conversationMessages),
        max_tokens: this.providerConfig.maxTokens || 2000,
        temperature: this.providerConfig.temperature || 0.7,
      };

      if (systemMessage) {
        requestBody.system = systemMessage.content;
      }

      const response = await this.client.post('/messages', requestBody);

      const content = response.data.content[0];

      return {
        content: content.text || '',
        finishReason: response.data.stop_reason,
        raw: response.data,
      };
    } catch (error: unknown) {
      throw new Error(
        `Anthropic API error: ${getNestedApiErrorMessage(error) || getErrorMessage(error, 'Request failed')}`,
      );
    }
  }

  /**
   * Format messages for Anthropic API
   */
  private formatMessages(
    messages: Message[],
  ): Array<{ role: 'assistant' | 'user'; content: string }> {
    return messages.map((msg) => ({
      role: msg.role === 'assistant' ? 'assistant' : 'user',
      content: msg.content,
    }));
  }

  getClient(): AxiosInstance {
    return this.client;
  }

  getModel(): string {
    return this.model;
  }

  getProviderConfig(): AnthropicConfig {
    return this.providerConfig;
  }
}
