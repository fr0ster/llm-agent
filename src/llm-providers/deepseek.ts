/**
 * DeepSeek LLM Provider
 */

import axios, { type AxiosInstance } from 'axios';
import type { LLMProviderConfig, LLMResponse, Message } from '../types.js';
import { getErrorMessage, getNestedApiErrorMessage } from '../utils/errors.js';
import { BaseLLMProvider } from './base.js';

export interface DeepSeekConfig extends LLMProviderConfig {
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export class DeepSeekProvider extends BaseLLMProvider {
  private client: AxiosInstance;
  private model: string;
  private providerConfig: DeepSeekConfig;

  constructor(config: DeepSeekConfig) {
    super(config);
    this.validateConfig();
    this.providerConfig = config;

    this.model = config.model || 'deepseek-chat';

    this.client = axios.create({
      baseURL: config.baseURL || 'https://api.deepseek.com/v1',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
    });
  }

  async chat(messages: Message[]): Promise<LLMResponse> {
    try {
      const response = await this.client.post('/chat/completions', {
        model: this.model,
        messages: this.formatMessages(messages),
        temperature: this.providerConfig.temperature || 0.7,
        max_tokens: this.providerConfig.maxTokens || 2000,
      });

      const choice = response.data.choices[0];

      return {
        content: choice.message.content || '',
        finishReason: choice.finish_reason,
        raw: response.data,
      };
    } catch (error: unknown) {
      throw new Error(
        `DeepSeek API error: ${getNestedApiErrorMessage(error) || getErrorMessage(error, 'Request failed')}`,
      );
    }
  }

  /**
   * Format messages for DeepSeek API
   */
  private formatMessages(
    messages: Message[],
  ): Array<{ role: Message['role']; content: string }> {
    return messages.map((msg) => ({
      role: msg.role,
      content: msg.content,
    }));
  }

  getClient(): AxiosInstance {
    return this.client;
  }

  getModel(): string {
    return this.model;
  }

  getProviderConfig(): DeepSeekConfig {
    return this.providerConfig;
  }
}
