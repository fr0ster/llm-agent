/**
 * Anthropic (Claude) LLM Provider
 */

import axios, { type AxiosInstance } from 'axios';
import type { LLMProviderConfig, LLMResponse, Message } from '../types.js';
import { BaseLLMProvider } from './base.js';

export interface AnthropicConfig extends LLMProviderConfig {
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export class AnthropicProvider extends BaseLLMProvider<AnthropicConfig> {
  readonly client: AxiosInstance;
  readonly model: string;

  constructor(config: AnthropicConfig) {
    super(config);
    this.validateConfig();

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

      const requestBody: Record<string, unknown> = {
        model: this.model,
        messages: this.formatMessages(conversationMessages),
        max_tokens: this.config.maxTokens || 4096,
        temperature: this.config.temperature || 0.7,
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
      const message = axios.isAxiosError(error)
        ? (error.response?.data as { error?: { message?: string } })?.error
            ?.message || error.message
        : error instanceof Error
          ? error.message
          : String(error);
      throw new Error(`Anthropic API error: ${message}`);
    }
  }

  // biome-ignore lint/correctness/useYield: intentionally unimplemented generator — streaming goes through AnthropicAgent
  async *streamChat(_messages: Message[]): AsyncIterable<LLMResponse> {
    throw new Error(
      'AnthropicProvider.streamChat() is not used directly. Use AnthropicAgent.streamLLMWithTools() for streaming.',
    );
  }

  async getModels(): Promise<string[]> {
    const response = await this.client.get('/models');
    return (response.data.data as Array<{ id: string }>).map((m) => m.id);
  }

  /**
   * Format messages for Anthropic API
   */
  private formatMessages(messages: Message[]): Array<Record<string, unknown>> {
    return messages.map((msg) => ({
      role: msg.role === 'assistant' ? 'assistant' : 'user',
      content: msg.content,
    }));
  }
}
